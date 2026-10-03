import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const executable = resolve(
  process.env.HARNESS_NATIVE_EXECUTABLE ?? "src-tauri/target/debug/harness-desktop.exe",
);
const applicationOrigin = "http://tauri.localhost";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function deadline<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export class NativeApplication {
  readonly page: Page;
  readonly pid: number;

  private constructor(
    private readonly child: ChildProcess,
    private readonly browser: Browser,
    page: Page,
    private readonly exited: Promise<void>,
    readonly errors: string[],
    private readonly artifacts: string,
  ) {
    this.pid = child.pid!;
    this.page = page;
  }

  static async launch(
    profile: string,
    artifacts: string,
    appProfile = join(profile, "app"),
    cwd = profile,
  ) {
    if (process.platform !== "win32") {
      throw new Error("The native CDP harness currently requires Windows WebView2");
    }
    await mkdir(profile, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const port = await freePort();
    const log = createWriteStream(join(artifacts, "process.log"));
    const environment = { ...process.env };
    // Release qualification can exclude system Node without changing the runner's PATH.
    if (process.env.HARNESS_NATIVE_PATH !== undefined) {
      for (const key of Object.keys(environment))
        if (key.toLowerCase() === "path") delete environment[key];
      environment.Path = process.env.HARNESS_NATIVE_PATH;
    }
    const child = spawn(executable, [], {
      cwd: resolve(cwd),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...environment,
        HARNESS_HOME: resolve(appProfile),
        HARNESS_CLIENT_HOME: resolve(appProfile),
        APPDATA: resolve(join(profile, "appdata")),
        LOCALAPPDATA: resolve(join(profile, "local-appdata")),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENCODE_API_KEY: "",
        WEBVIEW2_USER_DATA_FOLDER: resolve(profile),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      },
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
      log.end();
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.once("close", () => log.end());
    let browser: Browser | undefined;
    try {
      await expect(async () => {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Native process exited before attachment: ${child.exitCode}`);
        }
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        expect(response.ok).toBe(true);
      }).toPass({ timeout: 20_000, intervals: [100, 250, 500] });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 15_000,
      });
      let page: Page | undefined;
      await expect
        .poll(() => {
          page = browser!
            .contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => new URL(candidate.url()).origin === applicationOrigin);
          return Boolean(page);
        })
        .toBe(true);
      const errors: string[] = [];
      page!.on("pageerror", (error) => errors.push(error.message));

      // Prove this endpoint belongs to the launched native process, not another app.
      const session = await browser.newBrowserCDPSession();
      const info = await session.send("SystemInfo.getProcessInfo");
      const browserProcess = info.processInfo.find((entry) => entry.type === "browser");
      if (!browserProcess) throw new Error("CDP did not identify its browser process");
      await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$candidate = ${browserProcess.id}; $expected = ${child.pid}; ` +
            "while ($candidate -ne $expected -and $candidate -gt 0) { " +
            '$entry = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate"; ' +
            "if (-not $entry) { throw 'Missing process ancestor' }; " +
            "$candidate = $entry.ParentProcessId }; " +
            "if ($candidate -ne $expected) { throw 'CDP belongs to another process' }",
        ],
        { timeout: 10_000, windowsHide: true },
      );
      await session.detach();
      return new NativeApplication(child, browser, page!, exited, errors, artifacts);
    } catch (error) {
      try {
        await browser?.close();
      } finally {
        await NativeApplication.terminate(child, exited);
      }
      throw error;
    }
  }

  async waitForExit() {
    await deadline(this.exited, 60_000, "Native application did not exit");
    await this.close();
  }

  async close() {
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            resolve("tests/native/close-window.ps1"),
            "-AppProcess",
            String(this.pid),
            "-Evidence",
            join(this.artifacts, "close-window.json"),
          ],
          { timeout: 5_000, windowsHide: true },
        );
        // Wait for server-owned conversations and commands to drain on window close.
        await deadline(this.exited, 60_000, "Native application did not close");
      }
      expect(this.child.signalCode, "Native process was terminated").toBeNull();
      expect(this.child.exitCode, "Native process exited unsuccessfully").toBe(0);
    } finally {
      try {
        await this.browser.close();
      } finally {
        await NativeApplication.terminate(this.child, this.exited);
      }
    }
  }

  async kill() {
    try {
      await NativeApplication.terminate(this.child, this.exited);
    } finally {
      await this.browser.close();
    }
  }

  async serverPid(): Promise<number> {
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${this.pid}' | Where-Object { $_.Name -eq 'node.exe' }); if ($children.Count -ne 1) { throw 'Expected one owned Node server' }; $children[0].ProcessId`,
      ],
      { windowsHide: true },
    );
    return Number(stdout.trim());
  }

  async crashServer(): Promise<number> {
    const pid = await this.serverPid();
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force`],
      { windowsHide: true },
    );
    return pid;
  }

  async controlServer(action: "suspend" | "resume"): Promise<number> {
    const pid = await this.serverPid();
    await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve("tests/native/control-process.ps1"),
        "-TargetProcess",
        String(pid),
        "-OwnerProcess",
        String(this.pid),
        "-Action",
        action,
      ],
      { windowsHide: true },
    );
    return pid;
  }

  static async processExists(pid: number): Promise<boolean> {
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      ],
      { windowsHide: true },
    );
    return stdout.trim() === "yes";
  }

  private static async terminate(child: ChildProcess, exited: Promise<void>) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 10_000,
        windowsHide: true,
      });
      await deadline(exited, 5_000, "Owned native process did not terminate");
    }
  }
}
