import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { OutputRef, ToolCall, ToolResult } from "./tools.ts";
import type { ProviderPayload, ToolSchema } from "./model.ts";

export interface ContextItem {
  item: Item;
  payload?: ProviderPayload;
}

export interface ContextSelectInput {
  conversationId: ConversationId;
  instructions: ContentBlock[];
  tools: ToolSchema[];
  items: Item[];
  payloads: ReadonlyMap<ItemId, ProviderPayload>;
}

export interface NewContextBuild {
  conversationId: ConversationId;
  instructions: ContentBlock[]; // cache-stable prefix
  tools: ToolSchema[];
  items: ContextItem[]; // selected items, in order
}

/** Recorded selection: the only source of truth for "what the model saw". */
export interface ContextBuild extends NewContextBuild {
  id: string;
  createdAt: number;
}

export interface ContextPolicy {
  select(input: ContextSelectInput): Promise<NewContextBuild>;
}

export type ToolGateVerdict = "allow" | "deny" | "ask";

export interface ToolGate {
  evaluate(call: ToolCall): Promise<ToolGateVerdict>;
}

export interface OutputProjectionContext {
  /** Spill bytes the model shouldn't see inline; the returned ref goes on `full`. */
  putBlob(bytes: Uint8Array): Promise<OutputRef>;
  toolName: string;
}

/**
 * Bounds a tool's output into model-facing content. The default projection passes
 * results through; "head+tail", "elide+link via blob" arrive as plugins. Async +
 * blob-capable so a projection can stash the raw output and hand the model a digest.
 */
export interface OutputProjection {
  project(result: ToolResult, ctx: OutputProjectionContext): Promise<ToolResult>;
}
