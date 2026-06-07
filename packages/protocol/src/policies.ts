import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ToolCall, ToolResult } from "./tools.ts";
import type { ProviderPayload, ToolSchema } from "./model.ts";
import type { Turn } from "./conversation.ts";

export type LoopBoundary =
  | "idle"
  | "before-model-step"
  | "after-model-step"
  | "after-tool-result"
  | "turn-complete";

export type DeliveryIntent = "send" | "steer" | "queue" | "interrupt";
export type DeliveryAction = "start-turn" | "inject" | "hold" | "cancel-and-restart";

export interface DeliveryInput {
  intent: DeliveryIntent;
  boundary: LoopBoundary;
  turn?: Turn;
}

/** Maps (intent, boundary) → action. Changing queue↔steer edits only this. */
export interface DeliveryPolicy {
  decide(input: DeliveryInput): DeliveryAction;
}

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

/**
 * Bounds a tool's output into model-facing content. The trivial slice projection
 * passes results through; "head+tail", "elide+link via blob" arrive as plugins.
 */
export interface OutputProjection {
  project(result: ToolResult): ToolResult;
}
