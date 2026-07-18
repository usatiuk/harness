import type {
  ByteRange,
  PluginEvent,
  ToolCall,
  ToolContext,
  ToolContributionContext,
} from "@harness/protocol";

/**
 * Where a tool call acts relative to the workspace. Computed by the substrate (not
 * the tool), so it is trustworthy policy input. Binary in v0.
 */
export type Relationship = "in-workspace" | "out-of-workspace";
export type ShellKind = "bash" | "powershell";

export interface ProcessExit {
  /** The child exit code, or null when it did not exit normally. */
  code: number | null;
  signal: string | null;
  /** Present when the command interpreter could not be started. */
  error?: Error;
}

/**
 * A streaming child process — the primitive an activity is built on. Completion prefers stdio
 * drain but falls back to a watchdog after `exit`, so a command that forks children can't hang the
 * watcher; `kill` targets the whole process tree. Activity-ignorant: this is a raw IO primitive.
 */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** Resolves when the child exits or fails to start. */
  readonly exit: Promise<ProcessExit>;
  /** Subscribe to decoded stdout+stderr chunks, in arrival order. */
  onData(listener: (chunk: string) => void): void;
  /** Terminate the complete process tree. Idempotent. */
  kill(): void;
}

/** A streaming writer for a spilled output file; `path` is workspace-relative. */
export interface OutputWriter {
  readonly path: string;
  write(chunk: string): void;
  /** Append an optional footer, flush, and close. */
  close(footer?: string): Promise<void>;
}

/**
 * Preserves large/streamed tool output as a real workspace file (so the model can inspect
 * it) under `<root>/.harness/<conversationId>/outputs/<id>.log`, auto-gitignored. The substrate owns
 * where files live, so it swaps for docker/remote without touching callers.
 */
export interface OutputStore {
  /** Open a streaming writer for output `id`. */
  open(id: string): OutputWriter;
  /** Write `text` in one shot; resolves to the workspace-relative path. */
  put(id: string, text: string): Promise<string>;
}

/**
 * The IO contract a substrate implements and tools/approval consume — the single
 * chokepoint for reads, writes, listings, and commands, so calls are classifiable
 * and the substrate (local/docker/remote) swaps without touching tools. Plugin-tier,
 * not kernel protocol: the kernel ferries the handle but never calls these methods.
 */
export interface ExecutionContext {
  /** The root commands run in and paths resolve against; `null` when projectless. */
  readonly workspaceRoot: string | null;
  /** Command language exposed by this execution backend. */
  readonly shellKind: ShellKind;
  read(path: string, range?: ByteRange): Promise<Uint8Array>;
  /** Path metadata, or `undefined` when the path does not exist — lets callers tell a directory
   *  from a file without inferring it from a failed read. */
  stat(path: string): Promise<{ isDirectory: boolean } | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes `path`. Errors if it does not exist. */
  remove(path: string): Promise<void>;
  /** Workspace-relative paths matching a glob. Rejects when projectless. */
  list(pattern: string): Promise<string[]>;
  /** Start a streaming child process (cwd = workspace root) — the primitive activities build on. */
  spawn(command: string): SpawnedProcess;
  /** Output store for this conversation's spilled files. */
  outputStore(conversationId: string): OutputStore;
  /** The substrate's verdict on where a call acts — the approval policy's input. */
  classify(call: ToolCall): Relationship;
  /**
   * Optional: callers pass a scoped event-emit channel, letting a substrate that provisions lazily
   * (docker) stream build progress before/outside a turn. `executionOf` rebinds it on every access
   * with the live tool context's emit; `Engine.prepare` binds it once at startup with the engine's
   * plugin-emit seam. The local substrate doesn't implement it. Must stay cheap and idempotent.
   */
  bind?(emit: (event: PluginEvent) => void): void;
}

/** Narrows an opaque execution service for tool contribution or execution. */
export function executionServiceOf(
  ctx: Pick<ToolContributionContext, "service">,
): ExecutionContext {
  const execution = ctx.service("execution") as ExecutionContext | undefined;
  if (!execution) {
    throw new Error("no execution backend configured (add an execution plugin)");
  }
  if (execution.shellKind !== "bash" && execution.shellKind !== "powershell") {
    throw new Error("execution backend has an invalid shell kind");
  }
  return execution;
}

export function executionOf(ctx: ToolContext): ExecutionContext {
  const execution = executionServiceOf(ctx);
  execution.bind?.((event) => ctx.emit(event));
  return execution;
}
