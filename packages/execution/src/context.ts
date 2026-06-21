import type { ByteRange, ToolCall, ToolContext } from "@harness/protocol";

/**
 * Where a tool call acts relative to the workspace. Computed by the substrate (not
 * the tool), so it is trustworthy policy input. Binary in v0.
 */
export type Relationship = "in-workspace" | "out-of-workspace";

/**
 * A streaming child process — the primitive an activity is built on. Completion prefers stdio
 * drain but falls back to a watchdog after `exit`, so a command that forks children can't hang the
 * watcher; `kill` targets the whole process group. Activity-ignorant: this is a raw IO primitive.
 */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** Resolves when the child exits. `code` is null when terminated by `signal`. */
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  /** Subscribe to decoded stdout+stderr chunks, in arrival order. */
  onData(listener: (chunk: string) => void): void;
  /** SIGTERM the process group, then SIGKILL after a grace period. Idempotent. */
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
 * Preserves large/streamed tool output as a real workspace file (so the model can `Read`/`Grep`
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
   * Optional: `executionOf` passes the live tool context on every access, letting a substrate that
   * provisions lazily (docker) capture an event-emit channel for build progress. The local
   * substrate doesn't implement it. Kept off the hot path — it must stay cheap and idempotent.
   */
  bind?(ctx: ToolContext): void;
}

/** Narrows the opaque `ctx.service("execution")` to `ExecutionContext`; throws if no plugin is wired. */
export function executionOf(ctx: ToolContext): ExecutionContext {
  const execution = ctx.service("execution") as ExecutionContext | undefined;
  if (!execution) {
    throw new Error("no execution backend configured (add an execution plugin)");
  }
  execution.bind?.(ctx);
  return execution;
}
