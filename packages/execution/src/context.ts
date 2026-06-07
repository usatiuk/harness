import type { ByteRange, ToolCall, ToolContext } from "@harness/protocol";

/**
 * Where a tool call acts relative to the workspace. Computed by the substrate (not
 * the tool), so it is trustworthy policy input. Binary in v0.
 */
export type Relationship = "in-workspace" | "out-of-workspace";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Aborts the child process when the turn is interrupted. */
  signal?: AbortSignal;
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
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Workspace-relative paths matching a glob. Rejects when projectless. */
  list(pattern: string): Promise<string[]>;
  run(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** The substrate's verdict on where a call acts — the approval policy's input. */
  classify(call: ToolCall): Relationship;
}

/** Narrows the opaque `ctx.execution` to `ExecutionContext`; throws if no plugin is wired. */
export function executionOf(ctx: ToolContext): ExecutionContext {
  if (!ctx.execution) {
    throw new Error("no execution backend configured (add an execution plugin)");
  }
  return ctx.execution as ExecutionContext;
}
