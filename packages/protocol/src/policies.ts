import type { ContentBlock } from "./content.ts";
import type { ConversationId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ProviderPayload, ToolSchema } from "./model.ts";

export interface ContextItem {
  item: Item;
  payload?: ProviderPayload;
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

export interface CompactionInput {
  conversationId: ConversationId;
  items: Item[]; // the current (bounded) context window, in seq order
}

/**
 * Decides whether to fold the active context at a turn boundary. The returned
 * content is appended as one `compaction` item; everything before it leaves context.
 */
export interface CompactionStrategy {
  /** Summary content to fold the window into, or null to skip. */
  compact(input: CompactionInput): Promise<ContentBlock[] | null>;
}
