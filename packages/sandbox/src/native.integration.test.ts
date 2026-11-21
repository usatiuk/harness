import { discoverUserShellEnvironment, quoteShell } from "@harness/execution";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeExecutionContext } from "./native.ts";

const windows = process.platform === "win32";
const quote = (path: string) =>
  windows ? "'" + path.replaceAll("'", "''") + "'" : quoteShell(path);

async function command(context: NativeExecutionContext, script: string): Promise<string> {
  let output = "";
  const handle = context.spawn(script);
  handle.onData((chunk) => (output += chunk));
  const result = await handle.exit;
  if (result.error) throw result.error;
  expect(result.code, output).toBe(0);
  return output.trim();
}

describe.runIf(process.env.HARNESS_NATIVE_INTEGRATION === "1")(
  "NativeExecutionContext (real MXC)",
  () => {
    let fixture = "";
    let root = "";
    let outside = "";
    let writable: NativeExecutionContext;
    let readonly: NativeExecutionContext;
    let scratch = "";

    beforeAll(async () => {
      fixture = await realpath(await mkdtemp(join(process.cwd(), ".harness-mxc-test-")));
      root = join(fixture, "workspace");
      outside = join(fixture, "outside.txt");
      await mkdir(root);
      await writeFile(outside, "outside");
      writable = new NativeExecutionContext(root, { workspaceWrite: true, network: false });
      readonly = new NativeExecutionContext(root, { workspaceWrite: false, network: false });
      await Promise.all([writable.prepare(), readonly.prepare()]);
    }, 15_000);

    afterAll(async () => {
      await Promise.all([writable?.dispose(), readonly?.dispose()]);
      if (fixture) await rm(fixture, { recursive: true, force: true });
    }, 15_000);

    it("confines the shell and file operations with the same workspace policy", async () => {
      const bytes = Buffer.alloc(256 * 1024 + 1, 255);
      await writable.write("sample.bin", bytes);
      expect(await readonly.list("*.bin")).toEqual(["sample.bin"]);
      expect(await readonly.read("sample.bin")).toEqual(bytes);
      expect(await readonly.read("sample.bin", { offset: 1, length: 3 })).toEqual(
        bytes.subarray(1, 4),
      );
      expect(await readonly.stat("missing")).toBeUndefined();
      expect(Buffer.from(await readonly.read(outside)).toString()).toBe("outside");
      expect(
        await command(
          readonly,
          windows ? "Get-Content " + quote(outside) : "cat " + quote(outside),
        ),
      ).toBe("outside");
      await expect(writable.write(outside, bytes)).rejects.toThrow();
      await expect(readonly.write("sample.bin", bytes)).rejects.toThrow();
      const overwrite = windows
        ? "$ErrorActionPreference = 'Stop'; Set-Content -LiteralPath 'sample.bin' -Value 'forbidden'"
        : "printf forbidden > sample.bin";
      const rejected = await readonly.spawn(overwrite).exit;
      expect(rejected.error).toBeUndefined();
      expect(rejected.code).not.toBe(0);
      expect(await readFile(join(root, "sample.bin"))).toEqual(bytes);
      const escape = join(root, "escape");
      await symlink(fixture, escape, windows ? "junction" : "dir");
      await expect(writable.write("escape/outside.txt", bytes)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("outside");
      await writable.remove("sample.bin");
      expect(await readonly.stat("sample.bin")).toBeUndefined();
    }, 15_000);

    it("shares scratch between shell commands and file tools in a read-only workspace", async () => {
      scratch = await command(
        readonly,
        windows ? "Write-Output $env:TEMP" : 'printf "%s" "$TMPDIR"',
      );
      const path = join(scratch, "shared.txt");
      await readonly.write(path, Buffer.from("file tool says æ"));
      expect(
        await command(
          readonly,
          windows ? "Get-Content -Encoding UTF8 " + quote(path) : "cat " + quote(path),
        ),
      ).toBe("file tool says æ");
      await command(
        readonly,
        windows
          ? 'Set-Content (Join-Path $env:TMP "shared.txt") "shell says hi"'
          : 'printf "shell says hi" > "$TMP/shared.txt"',
      );
      expect(
        Buffer.from(await readonly.read(path))
          .toString()
          .trim(),
      ).toBe("shell says hi");
      await readonly.remove(path);
    });

    it("blocks host loopback even when outbound networking is enabled", async () => {
      const context = new NativeExecutionContext(root, { workspaceWrite: false, network: true });
      const listener = createServer((_request, response) => response.end("host response"));
      try {
        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        const url = `http://127.0.0.1:${address.port}`;
        expect(await (await fetch(url)).text()).toBe("host response");

        const probe = join(root, "loopback-probe.mjs");
        await writeFile(
          probe,
          `import { createConnection } from "node:net";
          const socket = createConnection({ host: "127.0.0.1", port: Number(process.argv[2]) });
          const blocked = () => {
            process.stdout.write("connection blocked");
            socket.destroy();
          };
          socket.once("error", blocked);
          socket.setTimeout(2000, blocked);
          socket.once("connect", () => {
            process.stdout.write("host reached");
            socket.destroy();
          });`,
        );
        const attempt = `${windows ? "& " : ""}${quote(process.execPath)} ${quote(probe)} ${address.port}`;
        for (const sandbox of [context, readonly]) {
          expect(await command(sandbox, attempt)).toBe("connection blocked");
        }
      } finally {
        await context.dispose();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    }, 15_000);

    it("cancels during launch", async () => {
      const handle = writable.spawn(windows ? "Start-Sleep -Seconds 60" : "sleep 60");
      handle.kill();
      const result = await handle.exit;
      expect(result.error).toBeUndefined();
      expect(result.code).not.toBeNull();
      expect(result.code).not.toBe(0);
    });

    it("cancels a running shell when the execution context closes", async () => {
      const context = new NativeExecutionContext(root, { workspaceWrite: true, network: false });
      const process = context.spawn(
        windows ? 'Write-Output "ready"; Start-Sleep -Seconds 60' : "echo ready; sleep 60",
      );
      await Promise.race([
        new Promise<void>((resolve) => process.onData(() => resolve())),
        process.exit.then(({ error }) => {
          throw error ?? new Error("Shell exited before emitting readiness");
        }),
      ]);
      await context.dispose();
      const result = await process.exit;
      expect(result.error).toBeUndefined();
      expect(result.code).not.toBe(0);
    });

    for (const shell of ["/bin/bash", "/bin/zsh"].filter(existsSync)) {
      it("reuses " + shell + " startup exports without sourcing startup again", async () => {
        const home = await mkdtemp(join(root, "shell-"));
        const rc =
          'echo invocation >> "$HOME/rc-count"\nexport NATIVE_STARTUP_EXPORT=available\nalias startup_alias="echo no"\n';
        await writeFile(join(home, shell.endsWith("zsh") ? ".zshrc" : ".bashrc"), rc);
        if (shell.endsWith("bash"))
          await writeFile(join(home, ".bash_profile"), 'source "$HOME/.bashrc"\n');
        const environment = await discoverUserShellEnvironment({
          env: { HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" },
        });
        const context = new NativeExecutionContext(
          root,
          { workspaceWrite: true, network: false },
          environment,
        );
        await context.prepare();
        expect(
          await command(
            context,
            'printf "%s" "$NATIVE_STARTUP_EXPORT"; ! type startup_alias >/dev/null 2>&1',
          ),
        ).toBe("available");
        expect(await readFile(join(home, "rc-count"), "utf8")).toBe("invocation\n");
        await context.dispose();
      });
    }
  },
);
