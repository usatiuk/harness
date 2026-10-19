import { linkedGitDirectories } from "@harness/worktrees";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ByteRange, ToolCall } from "@harness/protocol";
import {
  executionEscalationOf,
  LocalExecutionContext,
  LocalOutputStore,
  streamProcess,
  selectUserShell,
  shellCommandArgs,
  type UserShellEnvironment,
  type ExecutionContext,
  type OutputStore,
  type Relationship,
  type SpawnedProcess,
} from "@harness/execution";
import type { NativeSandboxConfig } from "./config.ts";

// Shared by commands in this server process. A restart gets a fresh directory;
// old directories are left to the operating system's temporary-file cleanup.
let temporaryDirectory: string | undefined;
const commandTemporaryDirectory = (): string =>
  (temporaryDirectory ??= mkdtempSync(join(tmpdir(), "harness-native-tmp-")));

function bubblewrapProbe(network: boolean) {
  return spawnSync(
    "bwrap",
    [
      "--die-with-parent",
      "--unshare-all",
      ...(network ? ["--share-net"] : []),
      "--ro-bind",
      "/",
      "/",
      "true",
    ],
    { encoding: "utf8" },
  );
}

/** Server-side default selection; explicit native activation still validates and fails. */
export function nativeSandboxAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = bubblewrapProbe(true);
  return !probe.error && probe.status === 0;
}

function denied(operation: string, path: string): Error {
  return Object.assign(new Error(`${operation} denied by native sandbox: ${path}`), {
    code: "EACCES",
  });
}

/**
 * Keep `/run` and `/tmp` private without breaking a host `/etc/resolv.conf` symlink into either
 * tree. Only the resolved config file is exposed; runtime sockets and the rest of the tree remain
 * hidden. With network isolation enabled the resolver is intentionally left unavailable.
 */
function resolverMountArgs(): string[] {
  let target: string;
  try {
    target = realpathSync("/etc/resolv.conf");
  } catch {
    return [];
  }
  const privateRoot = ["/run", "/tmp"].find((root) => within(root, target));
  if (!privateRoot || target === privateRoot) return [];

  const dirs: string[] = [];
  for (let dir = dirname(target); dir !== privateRoot; dir = dirname(dir)) {
    dirs.push(dir);
  }
  dirs.reverse();
  return [...dirs.flatMap((dir) => ["--dir", dir]), "--ro-bind", target, target];
}

/**
 * Linux host execution constrained with Bubblewrap. Reads use the host implementation directly
 * because the configured boundary intentionally permits host-wide reads; writes enforce the same
 * workspace rule in-process that the Bubblewrap mount table enforces for commands.
 */
export class NativeExecutionContext implements ExecutionContext {
  readonly workspaceRoot: string | null;
  readonly commandShell: UserShellEnvironment;
  get shellKind() {
    return this.commandShell.kind;
  }
  readonly unconfined: LocalExecutionContext;
  readonly #managedTools = new Set<string>();
  #gitDirectory: string | undefined;

  constructor(
    workspaceRoot: string | null,
    readonly config: NativeSandboxConfig,
    commandShell?: UserShellEnvironment,
  ) {
    if (process.platform !== "linux") {
      throw new Error(`native sandbox is unsupported on ${process.platform}`);
    }
    this.workspaceRoot = workspaceRoot ? realpathSync(resolve(workspaceRoot)) : null;
    if (
      this.workspaceRoot &&
      (within(this.workspaceRoot, "/tmp") || within(this.workspaceRoot, "/run"))
    ) {
      throw new Error(
        `native sandbox workspace cannot contain its private /tmp or /run mount: ${this.workspaceRoot}`,
      );
    }
    const probe = bubblewrapProbe(config.network);
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `native sandbox requires usable bubblewrap (bwrap): ${
          probe.error?.message ?? probe.stderr.trim()
        }`,
      );
    }
    this.commandShell = commandShell ?? selectUserShell();
    this.unconfined = new LocalExecutionContext(this.workspaceRoot, this.commandShell);
  }

  async prepare(): Promise<void> {
    this.#gitDirectory = this.workspaceRoot
      ? (await linkedGitDirectories(this.workspaceRoot))?.common
      : undefined;
  }

  sandboxInstructions(): string {
    return [
      "Sandbox backend: native Linux (Bubblewrap).",
      this.workspaceRoot
        ? `Workspace: ${this.workspaceRoot} (${this.config.workspaceWrite ? "writable" : "read-only"}).`
        : "No workspace is selected; workspace writes are disabled.",
      `Command network access: ${this.config.network ? "enabled" : "disabled"}.`,
      "Host files outside writable mounts are read-only. Native file tools access host paths; shell commands use the sandbox mounts.",
      ...(this.#gitDirectory && this.config.workspaceWrite
        ? [`Shell commands may also write linked Git metadata at ${this.#gitDirectory}.`]
        : []),
      "Shell /tmp is private and writable, shared across commands and workspaces in this Harness server process. Server restart selects a fresh directory. Shell /run is fresh for each command; host /tmp and /run are hidden from commands.",
      "Host escape requires approval; use the tool's documented escalation mechanism for an individual call.",
    ].join("\n");
  }

  read(path: string, range?: ByteRange): Promise<Uint8Array> {
    return this.unconfined.read(path, range);
  }

  stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    return this.unconfined.stat(path);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.#assertWritable("write", path, true);
    await this.unconfined.write(path, bytes);
  }

  async remove(path: string): Promise<void> {
    await this.#assertWritable("remove", path, false);
    await this.unconfined.remove(path);
  }

  list(pattern: string): Promise<string[]> {
    return this.unconfined.list(pattern);
  }

  spawn(command: string): SpawnedProcess {
    const cwd = this.workspaceRoot ?? process.cwd();
    const args = [
      "--die-with-parent",
      "--unshare-all",
      ...(this.config.network ? ["--share-net"] : []),
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      commandTemporaryDirectory(),
      "/tmp",
      "--tmpfs",
      "/run",
      ...(this.config.network ? resolverMountArgs() : []),
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "TMP",
      "/tmp",
      "--setenv",
      "TEMP",
      "/tmp",
    ];
    if (this.workspaceRoot) {
      args.push(
        this.config.workspaceWrite ? "--bind" : "--ro-bind",
        this.workspaceRoot,
        this.workspaceRoot,
      );
    }
    if (this.#gitDirectory && this.config.workspaceWrite)
      args.push("--bind", this.#gitDirectory, this.#gitDirectory);
    // The process already inherits Harness's environment. Avoid a login shell: host profile
    // scripts can attempt IPC through services intentionally absent from the private /run (for
    // example Ubuntu im-config invokes systemd-cat and leaks journald errors into command output).
    args.push(
      "--chdir",
      cwd,
      "--",
      this.commandShell.executable,
      ...shellCommandArgs(this.shellKind, command),
    );

    const child = nodeSpawn("bwrap", args, { cwd, detached: true, env: this.commandShell.env });
    let killed = false;
    let settled = false;
    child.once("exit", () => (settled = true));
    child.once("error", () => (settled = true));
    const kill = (): void => {
      if (killed || settled || child.pid === undefined) return;
      killed = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 5000).unref();
    };
    return streamProcess(child, kill);
  }

  outputStore(conversationId: string): OutputStore {
    return new LocalOutputStore(this.workspaceRoot, conversationId);
  }

  registerManagedTool(name: string): void {
    this.#managedTools.add(name);
  }

  classify(call: ToolCall): Relationship {
    if (!this.#managedTools.has(call.name)) return "unknown";
    return executionEscalationOf(call.args) ? "out-of-workspace" : "in-workspace";
  }

  async #assertWritable(operation: string, path: string, followsTarget: boolean): Promise<void> {
    const root = this.workspaceRoot;
    if (!root || !this.config.workspaceWrite) throw denied(operation, path);
    const absolute = resolve(root, path);
    if (!within(root, absolute)) throw denied(operation, path);

    // A write follows an existing final symlink; a remove only unlinks it. For a missing target,
    // resolve the nearest existing ancestor so a symlinked parent cannot escape the workspace.
    let candidate = followsTarget ? absolute : dirname(absolute);
    for (;;) {
      try {
        if (!within(root, await realpath(candidate))) throw denied(operation, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(candidate);
        if (parent === candidate) throw denied(operation, path);
        candidate = parent;
      }
    }
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
