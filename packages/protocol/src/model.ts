import type { ContentBlock } from "./content.ts";
import type { ItemId } from "./ids.ts";
import type { Item } from "./items.ts";

export interface ModelConfig {
  provider: string;
  model: string;
  /** Provider-opaque effort token (e.g. reasoning level); absent = the model's default. */
  effort?: string;
}

/** One effort level a model offers. The `value` is opaque to everything but the provider. */
export interface EffortInfo {
  value: string;
  /** Display name; falls back to `value` when absent. */
  label?: string;
}

/** One selectable model in a provider's catalog. */
export interface ModelInfo {
  provider: string;
  model: string;
  /** Display name; falls back to `model` when absent. */
  label?: string;
  /** Effort levels this model offers, in display order. Absent/empty = no effort axis. */
  efforts?: EffortInfo[];
  /** Effort used when none is chosen; must be one of `efforts` when present. */
  defaultEffort?: string;
}

/** Canonical id for a model (ignores effort): `provider/model`. */
export const modelId = (m: { provider: string; model: string }): string =>
  `${m.provider}/${m.model}`;

/** Full selection id including effort when set: `provider/model[/effort]`. */
export const selectionId = (m: ModelConfig): string =>
  m.effort ? `${modelId(m)}/${m.effort}` : modelId(m);

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

// `*_delta` events are display-only; `reasoning`/`tool_call`/`completed` carry the
// authoritative items. `payload` is the item's opaque provider fidelity (round-tripped).
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      payload?: ProviderPayloadDraft;
    }
  | { type: "reasoning"; content: ContentBlock[]; payload?: ProviderPayloadDraft }
  | {
      type: "completed";
      content: ContentBlock[];
      payload?: ProviderPayloadDraft; // binds to the step's final assistant message
      usage: Usage;
    };

export interface ModelProvider {
  readonly provider: string;
  capabilities(): ProviderCapabilities;
  validateConfig(config: ModelConfig): void;
  /** Streams one model step. The signal aborts the underlying network stream. */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Selectable models this provider offers; absent = none. */
  listModels?(): ModelInfo[];
}
