import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  attachLocalServer,
  stopServer,
  readDiscovery,
  canonicalHome,
} from "@harness/connections/node";

const execute = promisify(execFile);
const executable = resolve(
  process.env.HARNESS_NATIVE_EXECUTABLE ?? "src-tauri/target/debug/harness-desktop.exe",
);
const applicationOrigin = "http://tauri.localhost";
const fixtureHomes = new Set<string>();

/** Background owners outlive each GUI; teardown stops the captured test homes explicitly. */
export async function stopNativeOwners(): Promise<void> {
  for (const home of fixtureHomes) {
    const owner = await readDiscovery(home);
    if (owner) {
      await stopServer(owner);
      await expect.poll(() => NativeApplication.processExists(owner.pid)).toBe(false);
    }
    fixtureHomes.delete(home);
  }
}

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
    readonly home: string,
  ) {
    this.pid = child.pid!;
    this.page = page;
  }

  static async launch(
    profile: string,
    artifacts: string,
    appProfile = join(profile, "app"),
    cwd = profile,
    env: Record<string, string> = {},
  ) {
    if (process.platform !== "win32") {
      throw new Error("The native CDP harness currently requires Windows WebView2");
    }
    await mkdir(profile, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    appProfile = await canonicalHome(appProfile);
    fixtureHomes.add(appProfile);
    const port = process.env.HARNESS_NATIVE_DEBUG_PORT
      ? Number(process.env.HARNESS_NATIVE_DEBUG_PORT)
      : await freePort();
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("Invalid native debugging port");
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
        ...env,
        HARNESS_HOME: resolve(appProfile),
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
      return new NativeApplication(child, browser, page!, exited, errors, artifacts, appProfile);
    } catch (error) {
      try {
        const metadata = await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | " +
              "Where-Object Name -in 'harness-desktop.exe', 'msedgewebview2.exe' | " +
              "Select-Object Name, ProcessId, ParentProcessId, " +
              "@{Name='DebugPort';Expression={[regex]::Match($_.CommandLine,'--remote-debugging-port=(\\d+)').Groups[1].Value}} | ConvertTo-Json -Compress",
          ],
          { timeout: 10_000, windowsHide: true },
        );
        // Process IDs/ports only: never publish command lines, profiles or file contents.
        console.error("Native attachment metadata", {
          pid: child.pid,
          port,
          processes: metadata.stdout,
        });
      } finally {
        try {
          await browser?.close();
        } finally {
          await NativeApplication.terminate(child, exited);
        }
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
        // GUI shutdown detaches bridges; background owners have independent lifetime.
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
    const owner = await attachLocalServer(this.home);
    try {
      return owner.identity.pid;
    } finally {
      owner.close();
    }
  }

  async crashServer(): Promise<number> {
    return this.controlServer("crash");
  }

  private controlledOwner: { pid: number; command: string } | undefined;
  async controlServer(action: "suspend" | "resume" | "crash"): Promise<number> {
    let owner = this.controlledOwner;
    if (action !== "resume") {
      const pid = await this.serverPid();
      const { stdout } = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
        ],
        { windowsHide: true },
      );
      owner = { pid, command: stdout.trim() };
      if (!owner.command.includes("--background"))
        throw new Error("Expected authenticated background fixture owner");
      this.controlledOwner = owner;
    }
    if (!owner) throw new Error("Missing suspended fixture owner");
    await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve("tests/native/control-process.ps1"),
        "-TargetProcess",
        String(owner.pid),
        "-ExpectedCommand",
        owner.command,
        "-Action",
        action,
      ],
      { windowsHide: true },
    );
    return owner.pid;
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
