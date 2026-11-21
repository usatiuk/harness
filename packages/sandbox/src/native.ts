import { accessSync, constants, existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buffer, text } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import {
  getAvailableBackends,
  getPlatformSupport,
  MxcError,
  run,
  spawn,
  type ContainerRequest,
  type MxcProcess,
} from "@microsoft/mxc-sdk/v1";
import { linkedGitDirectories } from "@harness/worktrees";
import type { ByteRange, ToolCall } from "@harness/protocol";
import {
  executionEscalationOf,
  LocalExecutionContext,
  powerShellCommandArgs,
  quoteShell,
  shellCommandArgs,
  type ExecutionContext,
  type ProcessExit,
  type Relationship,
  type SpawnedProcess,
  type UserShellEnvironment,
} from "@harness/execution";
import type { NativeSandboxConfig } from "./config.ts";
import type { FileOperation } from "./native-file-worker.ts";

const windows = process.platform === "win32";
const platformBackend = {
  win32: "processcontainer",
  darwin: "seatbelt",
  linux: "bubblewrap",
} as const;
const source = import.meta.url.endsWith(".ts");
const fileWorker = fileURLToPath(
  new URL(source ? "./native-file-worker.ts" : "./native-file-worker.mjs", import.meta.url),
);

export type NativeSandboxHost = { available: true } | { available: false; reason: string };

let scratch: string | undefined;
function temporaryDirectory(): string {
  return (scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "harness-native-"))));
}

export function detectNativeSandboxHost(): NativeSandboxHost {
  const backend = platformBackend[process.platform as keyof typeof platformBackend];
  if (backend === undefined)
    return { available: false, reason: "requires Linux, macOS or Windows with MXC support" };
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24) return { available: false, reason: "MXC requires Node.js 24 or later" };
  if (windows && !(major === 24 ? minor >= 21 : major === 26 ? minor >= 8 : major > 26))
    return {
      available: false,
      reason: "MXC on Windows requires Node.js 24.21+ on the 24.x line or Node.js 26.8 or later",
    };
  // Harness only uses ProcessContainer on Windows. The full probe also starts a CLI process.
  if (windows)
    return getAvailableBackends().some((entry) => entry.backend === backend)
      ? { available: true }
      : { available: false, reason: "MXC ProcessContainer is unavailable on this Windows host" };
  const support = getPlatformSupport();
  if (support.availableMethods.includes(backend)) return { available: true };
  return {
    available: false,
    reason:
      support.unavailableReasons?.[backend] ||
      support.reason ||
      "MXC process isolation is unavailable",
  };
}

function networkPolicy(enabled: boolean): NonNullable<ContainerRequest["network"]> {
  return {
    egress: { default: enabled ? "allow" : "deny" },
    ingress: { default: "deny", hostLoopback: "deny" },
  };
}

/** Check the extra Linux egress requirements before selecting the server default. */
export async function nativeSandboxAvailable(host = detectNativeSandboxHost()): Promise<boolean> {
  if (!host.available) return false;
  if (process.platform !== "linux") return true;
  try {
    const probe = await run({
      command: "true",
      network: networkPolicy(true),
      timeoutMs: 5000,
    });
    return probe.exitCode === 0 && !probe.timedOut;
  } catch (error) {
    if (error instanceof MxcError && ["backend_error", "backend_unavailable"].includes(error.code))
      return false;
    throw error;
  }
}

function readonlyHostPaths(): string[] {
  if (windows)
    return Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (drive) => drive + ":\\").filter(existsSync);
  // Keep MXC's own device policy. On Linux a root bind also hides private mounts.
  const privateMounts = process.platform === "linux" ? ["dev", "proc", "run", "tmp"] : ["dev"];
  return readdirSync("/", { withFileTypes: true }).flatMap((entry) => {
    if ((!entry.isDirectory() && !entry.isFile()) || privateMounts.includes(entry.name)) return [];
    const path = "/" + entry.name;
    try {
      accessSync(path, constants.R_OK);
      return [path];
    } catch (error) {
      if (["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return [];
      throw error;
    }
  });
}

function commandLine(executable: string, args: string[]): string {
  const quote = windows
    ? (arg: string) =>
        '"' +
        arg.replace(
          /(\\*)("|$)/g,
          (_, slashes: string, end: string) => slashes + slashes + (end ? '\\"' : ""),
        ) +
        '"'
    : quoteShell;
  return [executable, ...args].map(quote).join(" ");
}

function launchError(error: unknown, network: boolean): Error {
  if (!(error instanceof MxcError))
    return error instanceof Error ? error : new Error(String(error));
  const guidance =
    error.remediation ||
    (process.platform === "linux"
      ? network
        ? "Check Bubblewrap, user namespaces, slirp4netns and the iptables tools on the server host. Native networking can also be disabled in settings."
        : "Check Bubblewrap and user namespaces on the server host."
      : "");
  return new Error(["MXC native sandbox: " + error.message, guidance].filter(Boolean).join(" "), {
    cause: error,
  });
}

export class NativeExecutionContext implements ExecutionContext {
  readonly workspaceRoot: string | null;
  readonly unconfined: LocalExecutionContext;
  readonly #managedTools = new Set<string>();
  readonly #active = new Set<{ kill(): void; result: Promise<unknown> }>();
  #disposed = false;
  #gitDirectory: string | undefined;
  #readonlyPaths: string[] | undefined;

  constructor(
    workspaceRoot: string | null,
    readonly config: NativeSandboxConfig,
    commandShell?: UserShellEnvironment,
  ) {
    this.workspaceRoot = workspaceRoot ? realpathSync(resolve(workspaceRoot)) : null;
    if (
      process.platform === "linux" &&
      this.workspaceRoot &&
      ["/", "/dev", "/proc", "/run", "/tmp"].includes(this.workspaceRoot)
    ) {
      throw new Error(
        `Native sandbox workspace cannot contain a private system mount: ${this.workspaceRoot}`,
      );
    }
    this.unconfined = new LocalExecutionContext(this.workspaceRoot, commandShell);
  }

  get shellKind() {
    return this.unconfined.shellKind;
  }

  async prepare(): Promise<void> {
    await this.unconfined.prepare();
    if (this.workspaceRoot && this.config.workspaceWrite)
      this.#gitDirectory = (await linkedGitDirectories(this.workspaceRoot))?.common;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const command of this.#active) command.kill();
    await Promise.allSettled([...this.#active].map((command) => command.result));
  }

  sandboxInstructions(): string {
    return [
      "Sandbox backend: native (MXC).",
      this.workspaceRoot
        ? "Workspace: " +
          this.workspaceRoot +
          (this.config.workspaceWrite ? " (writable)." : " (read-only).")
        : "No workspace is selected; workspace writes are disabled.",
      "External IP network access: " +
        (this.config.network ? "enabled for outbound connections." : "disabled."),
      "Host files outside writable paths are read-only.",
      ...(this.#gitDirectory
        ? ["Linked Git metadata is writable at " + this.#gitDirectory + "."]
        : []),
      "Use TMPDIR, TMP or TEMP for writable temporary files shared across commands and workspaces in this server. A server restart selects a fresh directory.",
      "Host escape requires approval; use the tool's documented escalation mechanism for an individual call.",
    ].join("\n");
  }

  #request(command: string): ContainerRequest {
    const env = this.unconfined.commandShell?.env ?? process.env;
    const tmp = temporaryDirectory();
    const writable = [tmp];
    // The macOS system resolver connects to this Unix socket for DNS.
    if (process.platform === "darwin" && this.config.network)
      writable.push("/var/run/mDNSResponder");
    if (this.workspaceRoot && this.config.workspaceWrite) writable.push(this.workspaceRoot);
    if (this.#gitDirectory) writable.push(this.#gitDirectory);
    const readonlyPaths = new Set(
      writable.includes("/") ? [] : (this.#readonlyPaths ??= readonlyHostPaths()),
    );
    if (this.workspaceRoot && this.workspaceRoot !== "/" && !this.config.workspaceWrite)
      readonlyPaths.add(this.workspaceRoot);
    for (const path of writable) readonlyPaths.delete(path);
    return {
      containment: { type: "process" },
      command,
      workingDirectory: this.workspaceRoot ?? tmp,
      environment: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      filesystem: {
        readonlyPaths: [...readonlyPaths],
        readwritePaths: [...new Set(writable)],
      },
      network: networkPolicy(this.config.network),
      // PowerShell and Node need Win32k to initialize on Windows.
      ...(windows ? { ui: { disable: false } } : {}),
    };
  }

  #launch<T>(command: string, consume: (child: MxcProcess) => Promise<T>) {
    if (this.#disposed) throw new Error("Native sandbox has been disposed");
    let child: MxcProcess | undefined;
    let pid: number | undefined;
    let cancelled = false;
    let killFailure: unknown;
    const terminate = () => {
      try {
        child?.kill();
      } catch (error) {
        killFailure = error;
        try {
          child?.dispose();
        } catch (cleanup) {
          killFailure = new AggregateError([error, cleanup], "Could not stop MXC command");
        }
      }
    };
    const result = (async () => {
      try {
        child = await spawn(this.#request(command));
        pid = child.id || undefined;
        if (cancelled) terminate();
        return await consume(child);
      } catch (error) {
        if (child && killFailure === undefined) {
          try {
            child.kill();
            await child.wait();
          } catch (cleanup) {
            if (cleanup !== error)
              throw new AggregateError([error, cleanup], "Could not stop MXC process", {
                cause: cleanup,
              });
          }
        }
        throw error;
      } finally {
        const launched = child;
        child = undefined;
        launched?.dispose();
      }
    })().catch((error: unknown) => {
      throw launchError(killFailure ?? error, this.config.network);
    });
    const handle = {
      get pid() {
        return pid;
      },
      result,
      kill: () => {
        if (cancelled) return;
        cancelled = true;
        terminate();
      },
    };
    this.#active.add(handle);
    const done = () => this.#active.delete(handle);
    void result.then(done, done);
    return handle;
  }

  spawn(command: string): SpawnedProcess {
    const shell = this.unconfined.commandShell;
    const line = shell
      ? commandLine(shell.executable, shellCommandArgs(shell.kind, command))
      : commandLine(
          join(process.env["SystemRoot"]!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          powerShellCommandArgs("$env:TMP = $env:TEMP = $env:TMPDIR\n" + command),
        );
    const listeners: ((chunk: string) => void)[] = [];
    const handle = this.#launch(line, async (child): Promise<ProcessExit> => {
      const drains = [child.standardOutput, child.standardError].flatMap((stream) => {
        if (!stream) return [];
        stream.setEncoding("utf8").on("data", (chunk: string) => {
          for (const listener of listeners) listener(chunk);
        });
        return [finished(stream, { cleanup: true })];
      });
      const [result] = await Promise.all([child.wait(), ...drains]);
      return { code: result.exitCode, signal: null };
    });
    return {
      get pid() {
        return handle.pid;
      },
      exit: handle.result.catch((error: Error) => ({ code: null, signal: null, error })),
      onData: (listener) => listeners.push(listener),
      kill: handle.kill,
    };
  }

  #file(operation: FileOperation, bytes?: Uint8Array): Promise<Buffer> {
    const args = source
      ? ["--conditions=development", "--import", import.meta.resolve("tsx"), fileWorker]
      : [fileWorker];
    return this.#launch(commandLine(process.execPath, args), async (child) => {
      const input = child.standardInput;
      const output = child.standardOutput;
      const errors = child.standardError;
      if (!input || !output || !errors) throw new Error("MXC file tool requires standard pipes");
      input.write(JSON.stringify({ workspace: this.workspaceRoot !== null, operation }) + "\n");
      input.end(bytes);
      const [result, data, stderr] = await Promise.all([
        child.wait(),
        buffer(output),
        text(errors),
      ]);
      if (result.exitCode !== 0) {
        let failure: { message?: string; code?: string };
        try {
          failure = JSON.parse(stderr) as typeof failure;
        } catch {
          failure = { message: stderr.trim() };
        }
        throw Object.assign(
          new Error(failure.message || `MXC file tool exited with code ${result.exitCode}`),
          { code: failure.code },
        );
      }
      return data;
    }).result;
  }

  read(path: string, range?: ByteRange): Promise<Uint8Array> {
    return this.#file({ kind: "read", path, range });
  }

  async stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    const data = await this.#file({ kind: "stat", path });
    return (JSON.parse(data.toString()) as { isDirectory: boolean } | null) ?? undefined;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.#file({ kind: "write", path }, bytes);
  }

  async remove(path: string): Promise<void> {
    await this.#file({ kind: "remove", path });
  }

  async list(pattern: string): Promise<string[]> {
    return JSON.parse((await this.#file({ kind: "list", pattern })).toString()) as string[];
  }

  outputStore(conversationId: string) {
    return this.unconfined.outputStore(conversationId);
  }

  registerManagedTool(name: string): void {
    this.#managedTools.add(name);
  }

  classify(call: ToolCall): Relationship {
    if (!this.#managedTools.has(call.name)) return "unknown";
    return executionEscalationOf(call.args) ? "out-of-workspace" : "in-workspace";
  }
}
