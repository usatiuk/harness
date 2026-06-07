import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
import type { Item } from "./items.ts";
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
