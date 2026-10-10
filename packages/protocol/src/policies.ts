import type { ContentBlock } from "./content.ts";
import type { ConversationId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ModelInvoker, ModelOutputItem, ProviderPayload, ToolSchema } from "./model.ts";
import type { JsonValue } from "./rpc.ts";

export interface ContextItem {
  item: Item;
  payload?: ProviderPayload;
}

export interface NewContextBuild {
  conversationId: ConversationId;
  /** Stable caller label, e.g. `agent` or `auto-approval`. */
  purpose?: string;
  instructions: ContentBlock[]; // cache-stable prefix
  tools: ToolSchema[];
  items: ContextItem[]; // selected items, in order
  /** Non-durable final user input included in this request. */
  prompt?: string;
  toolChoice?: "auto" | "none";
  maxOutputTokens?: number;
  providerOptions?: JsonValue;
}

/** Recorded selection: the only source of truth for "what the model saw". */
export interface ContextBuild extends NewContextBuild {
  id: string;
  createdAt: number;
}

export interface CompactionInput {
  reason: "threshold" | "overflow" | "manual";
  build: NewContextBuild;
  models: ModelInvoker;
  /** A bounded summary allowance when model capacity is known; absent uses the provider default. */
  outputTokenLimit?: number;
  signal: AbortSignal;
}

export interface CompactionResult {
  /** Canonical replacement context. Empty content is invalid. */
  content: ContentBlock[];
  /** Reasoning and tool calls emitted while compacting, continued after the fold. */
  outputItems?: ModelOutputItem[];
}

/**
 * Decides whether to fold the active context at a turn boundary. The returned
 * content is appended as one `compaction` item; everything before it leaves context.
 */
export interface CompactionStrategy {
  /** Replacement content plus continuation outputs, or null when there is nothing to fold. */
  compact(input: CompactionInput): Promise<CompactionResult | null>;
}
