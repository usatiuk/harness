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

/**
 * Per-call environment handed to a tool. The host `ExecutionContext`
 * (read/write/search/run) is added with the first real tool; the slice's tools
 * don't touch it.
 */
export interface ToolContext {
  conversationId: ConversationId;
  signal: AbortSignal;
  /** Emit a plugin-defined event onto the conversation's stream. */
  emit(event: PluginEvent): void;
}

export interface Tool {
  readonly name: string;
  readonly schema: ToolSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
