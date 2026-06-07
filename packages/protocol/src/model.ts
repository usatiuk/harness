import type { ContentBlock } from "./content.ts";
import type { ItemId } from "./ids.ts";
import type { Item } from "./items.ts";

export interface ModelConfig {
  provider: string;
  model: string;
}

export interface ProviderCapabilities {
  contentTypes: readonly string[];
  toolCalling: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Opaque per-item provider fidelity (encrypted reasoning, thought signatures, …).
 * Reused only when its item is selected AND provider/model/type/version all match;
 * otherwise the item renders from canonical content.
 */
export interface ProviderPayload {
  itemId: ItemId;
  provider: string;
  model: string;
  type: string;
  version: number;
  payload: unknown;
}

/** What a provider emits before its item exists; the loop binds `itemId` on append. */
export type ProviderPayloadDraft = Omit<ProviderPayload, "itemId">;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ModelRequest {
  instructions: ContentBlock[];
  items: { item: Item; payload?: ProviderPayload }[];
  tools?: ToolSchema[];
  modelConfig: ModelConfig;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "completed";
      content: ContentBlock[];
      payload?: ProviderPayloadDraft;
      usage: Usage;
    };

export interface ModelProvider {
  readonly provider: string;
  capabilities(): ProviderCapabilities;
  validateConfig(config: ModelConfig): void;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
