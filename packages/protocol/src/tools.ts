import type { ContentBlock } from "./content.ts";
import type { ConversationId } from "./ids.ts";
import type { ToolSchema } from "./model.ts";
import type { PluginEvent } from "./events.ts";

export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export type ToolStatus = "ok" | "error";

/** Reference to full raw output in the blob store; never auto-sent to the model. */
export interface OutputRef {
  id: string;
  bytes: number;
  contentType: string;
}

export interface ToolResult {
  forModel: ContentBlock[];
  full?: OutputRef;
  status: ToolStatus;
}

/** A single-text-block error result — the conventional shape for a failed or denied call. */
export const errorResult = (text: string): ToolResult => ({
  forModel: [{ type: "text", text }],
  status: "error",
});

/** Per-call environment handed to a tool. */
export interface ToolContext {
  conversationId: ConversationId;
  signal: AbortSignal;
  /**
   * Per-conversation execution handle from the execution plugin (`undefined` if none
   * is wired). Opaque to the kernel — narrow via `executionOf` from `@harness/execution`.
   */
  execution: unknown;
  /** Emit a plugin-defined event onto the conversation's stream. */
  emit(event: PluginEvent): void;
}

export interface Tool {
  readonly name: string;
  readonly schema: ToolSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** A point in the middleware chain: runs the next inner middleware, or the tool. */
export type ToolHandler = (call: ToolCall) => Promise<ToolResult>;

export interface ToolMiddlewareContext extends ToolContext {
  /** Spill bytes the model shouldn't see inline; the returned ref goes on `full`. */
  putBlob(bytes: Uint8Array): Promise<OutputRef>;
  /**
   * Block until the host (or a UI) answers a correlated request. The kernel only
   * ferries the opaque payload by id; the middleware owns the request/response shape
   * (e.g. `{kind:"approval", call}` → `{decision}`). Rejects if the turn is aborted.
   */
  request(request: unknown): Promise<unknown>;
}

/**
 * Wraps a tool call. `next` may be called zero times (deny/short-circuit), once
 * (normal), or many times (retry). Return a `ToolResult` either way — the chain
 * never throws past the engine. Subsumes the old `ToolGate` + `OutputProjection`.
 */
export interface ToolMiddleware {
  readonly id: string;
  wrap(call: ToolCall, ctx: ToolMiddlewareContext, next: ToolHandler): Promise<ToolResult>;
}
