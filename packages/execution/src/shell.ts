import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { ShellKind } from "./context.ts";

export interface UserShellEnvironment {
  readonly kind: Exclude<ShellKind, "powershell">;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}

import { defaultHostTimeouts } from "@harness/protocol";
export const SHELL_STARTUP_TIMEOUT_MS = defaultHostTimeouts.shellSeconds * 1000;
const STARTUP_KILL_GRACE_MS = 1000;
const MAX_EXPORT_BYTES = 1024 * 1024;
export const SHELL_EXPORT_MARKER = "\0HARNESS_SHELL_EXPORTS\0";

/** An explicit target SHELL wins; otherwise consult the executing account, not a client. */
export function selectUserShell(env: NodeJS.ProcessEnv = process.env): UserShellEnvironment {
  const account = userInfo();
  const executable = env["SHELL"] ?? account.shell;
  if (!executable || !isAbsolute(executable))
    throw new Error("User shell must be an absolute Bash or zsh executable (set SHELL)");
  const kind = basename(executable);
  if (kind !== "bash" && kind !== "zsh")
    throw new Error(`Unsupported user shell: ${executable}; supported shells are Bash and zsh`);
  return {
    kind,
    executable,
    env: commandEnvironment({ HOME: account.homedir, ...env, SHELL: executable }),
  };
}

/** Commands inherit exports, never a second startup, exported Bash functions or shell options. */
export function commandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key !== "BASH_ENV" &&
        key !== "ENV" &&
        key !== "SHELLOPTS" &&
        key !== "BASHOPTS" &&
        // Bash recomputes these readonly scalars; Docker's export transport cannot assign them.
        key !== "UID" &&
        key !== "EUID" &&
        key !== "PPID" &&
        !key.startsWith("BASH_FUNC_"),
    ),
  );
}

export function shellCommandArgs(kind: UserShellEnvironment["kind"], command: string): string[] {
  // Node's piped stdin can trigger Bash's remote-daemon rc heuristic even without -i.
  return kind === "zsh" ? ["-f", "-c", command] : ["--norc", "-c", command];
}

export function powerShellCommandArgs(command: string): string[] {
  const script = [
    "$utf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    "$global:LASTEXITCODE = $null",
    command,
    "$harnessSuccess = $?",
    "if (-not $harnessSuccess) {",
    "  if ($LASTEXITCODE) { exit $LASTEXITCODE }",
    "  exit 1",
    "}",
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Let Bash itself interpret BASH_ENV once; model commands never repeat that startup. */
export function shellExportScript(kind: UserShellEnvironment["kind"], capture: string): string {
  const command = `exec ${capture} >&3`;
  return [
    ...(kind === "bash"
      ? [
          'if [ -n "${BASH_ENV-}" ]; then',
          `  exec "$BASH" -c ${quoteShell(`exec ${capture}`)} >&3`,
          "fi",
        ]
      : []),
    command,
  ].join("\n");
}

export function parseShellExports(bytes: Buffer): NodeJS.ProcessEnv {
  // A complete env entry contains '='; this NUL-delimited marker cannot occur within exports.
  // Only the native BASH_ENV reader can produce chatter on the private channel before capture.
  const marker = bytes.lastIndexOf(SHELL_EXPORT_MARKER);
  if (marker < 0) throw new Error("Shell initialization did not produce a complete export record");
  bytes = bytes.subarray(marker + Buffer.byteLength(SHELL_EXPORT_MARKER));
  if (!bytes.length || bytes[bytes.length - 1] !== 0)
    throw new Error("Shell initialization did not produce a complete export record");
  const env: NodeJS.ProcessEnv = {};
  for (const entry of bytes.toString("utf8").split("\0").slice(0, -1)) {
    const split = entry.indexOf("=");
    if (split < 1) throw new Error("Shell initialization produced an invalid export record");
    Object.defineProperty(env, entry.slice(0, split), {
      value: entry.slice(split + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return env;
}

/**
 * Trusted target-user initialization only. Model commands are NEVER passed to this shell.
 * Native interactive-login ordering applies (Bash profiles must source .bashrc themselves).
 * Startup chatter is discarded, and the private export channel has a strict byte/deadline bound.
 */
export async function discoverUserShellEnvironment(
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<UserShellEnvironment> {
  const inherited = options.env ?? process.env;
  const selected = selectUserShell(inherited);
  options.signal?.throwIfAborted();
  // Node is already installed on this execution host; unlike `env -0`, this is also portable to macOS.
  const capture = `${quoteShell(process.execPath)} --input-type=commonjs -e ${quoteShell(
    `require("node:fs").writeFileSync(1, ${JSON.stringify(SHELL_EXPORT_MARKER)} + Object.entries(process.env).map(([k,v]) => k + "=" + v + "\\0").join(""))`,
  )}`;
  // Apple Bash closes descriptors 3 through 19 at interactive login. Move the
  // inherited pipe before login; the noninteractive wrapper ignores BASH_ENV.
  const appleBash = process.platform === "darwin" && selected.kind === "bash";
  const script = shellExportScript(selected.kind, capture);
  const args = appleBash
    ? [
        "-pc",
        'exec 20>&3 3>&-; exec "$0" -ilc "$1"',
        selected.executable,
        "exec 3>&20 20>&-\n" + script,
      ]
    : ["-ilc", script];
  const child = spawn(selected.executable, args, {
    env: {
      ...selected.env,
      ...(inherited["BASH_ENV"] === undefined ? {} : { BASH_ENV: inherited["BASH_ENV"] }),
    },
    cwd: selected.env["HOME"],
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const exports = child.stdio[3];
    if (!exports || !("readable" in exports)) throw new Error("Shell export pipe is unavailable");
    let failure: Error | undefined;
    let exited = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: Buffer | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const stop = (error: Error): void => {
      if (failure || settled) return;
      failure = error;
      // Escaped descendants may retain the write end indefinitely. Failure owns no more data;
      // close our read end and await the physical child, not arbitrary descendant pipe closure.
      exports.removeAllListeners("data");
      exports.destroy();
      chunks.length = 0;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH")
            failure = new Error("Shell initialization process group could not be stopped", {
              cause: killError,
            });
        }
      }
      if (exited || child.pid === undefined) finish(failure);
      else {
        killTimer = setTimeout(() => {
          failure = new Error("Shell initialization process did not exit after SIGKILL", {
            cause: failure,
          });
          child.unref();
          finish(failure);
        }, STARTUP_KILL_GRACE_MS);
      }
    };
    const abort = () => stop(new Error("Shell initialization cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const limit = options.timeoutMs ?? SHELL_STARTUP_TIMEOUT_MS;
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            `Shell initialization timed out after ${limit / 1000} seconds (host settings.json: timeouts.shellSeconds)`,
          ),
        ),
      limit,
    );
    exports.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EXPORT_BYTES) stop(new Error("Shell initialization exports exceed 1 MiB"));
      else chunks.push(chunk);
    });
    exports.on("error", () => stop(new Error("Shell initialization export transport failed")));
    child.once("error", () => {
      stop(new Error("Shell initialization could not launch the selected shell"));
    });
    child.once("exit", (code, signal) => {
      exited = true;
      if (failure) finish(failure);
      else if (code !== 0)
        stop(new Error(`Shell initialization failed (${signal ?? `exit ${code}`})`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (failure) finish(failure);
      else if (code !== 0)
        stop(new Error(`Shell initialization failed (${signal ?? `exit ${code}`})`));
      else finish(Buffer.concat(chunks));
    });
    if (options.signal?.aborted) abort();
  });
  return { ...selected, env: commandEnvironment(parseShellExports(bytes)) };
}

let initialization: Promise<void> | undefined;
/** Call after acquiring server ownership and before constructing plugins. Attachments never call it. */
export function initializeUserShellEnvironment(
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (process.platform === "win32") return Promise.resolve(); // PowerShell remains explicitly NoProfile.
  return (initialization ??= (async () => {
    const inherited = { ...process.env };
    const shell = await discoverUserShellEnvironment({ env: inherited, ...options });
    const pinned = (key: string) =>
      key.startsWith("HARNESS_") || key === "APPIMAGE" || key === "APPDIR";
    for (const key of Object.keys(process.env)) {
      if (!pinned(key) && shell.env[key] === undefined) delete process.env[key];
    }
    for (const [key, value] of Object.entries(shell.env)) {
      if (!pinned(key) && value !== undefined) process.env[key] = value;
    }
    process.env["SHELL"] = shell.executable;
    delete process.env["BASH_ENV"];
    delete process.env["ENV"];
    // The desktop bridge already sanitizes these; startup scripts must not undo that boundary.
    if (inherited["APPIMAGE"] || inherited["APPDIR"]) {
      delete process.env["LD_LIBRARY_PATH"];
      delete process.env["PYTHONHOME"];
    }
  })());
}
