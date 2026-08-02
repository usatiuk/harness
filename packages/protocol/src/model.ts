import { z } from "zod";
import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
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

/** Cache-write TTL expressed in seconds (provider-neutral; Anthropic: 300 = 5m, 3600 = 1h). */
export type CacheTtlSeconds = number;

/** Rate card in USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Absent = cached reads billed at the input rate. */
  cachedRead?: number;
  /** Write rate keyed by TTL seconds. */
  cacheWrite?: Record<CacheTtlSeconds, number>;
  /** Replacement card for a whole request whose inputTokens exceed the threshold. */
  longContext?: { threshold: number } & Omit<ModelPricing, "longContext">;
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
  /** Max context size in tokens; absent = unknown. */
  contextWindow?: number;
  /** Maximum output reservation used when deciding whether the next input still fits. */
  maxOutputTokens?: number;
  /** Absent = cost not computable for this model. */
  pricing?: ModelPricing;
}

/** Canonical id for a model (ignores effort): `provider/model`. */
export const modelId = (m: { provider: string; model: string }): string =>
  `${m.provider}/${m.model}`;

/** Catalog lookup by provider + model (ignores effort). */
export const findModel = (
  models: ModelInfo[],
  m: { provider: string; model: string },
): ModelInfo | undefined => models.find((x) => x.provider === m.provider && x.model === m.model);

/** Full selection id including effort when set: `provider/model[/effort]`. */
export const selectionId = (m: ModelConfig): string =>
  m.effort ? `${modelId(m)}/${m.effort}` : modelId(m);

/**
 * The file-editing tool profile a model is trained on — one indivisible choice that selects
 * the whole edit/read/write roster, so nonsense combinations can't be expressed.
 * `string_replace` is the neutral default; `apply_patch` is OpenAI's V4A; `text_editor` is the
 * provider-specific editor profile, whose plugin may contribute a Harness-owned tool with the
 * model's familiar schema.
 */
export type FileToolsProfile = "string_replace" | "apply_patch" | "text_editor";

/**
 * Identifies a provider's built-in (natively trained) tool, e.g. `"anthropic.text_editor"`.
 * Convention: `"<provider>.<family>"`. The provider maps it to its versioned wire type.
 */
export type NativeToolId = string;

export interface ModelCapabilities {
  contentTypes: readonly string[];
  toolCalling: boolean;
  fileTools: FileToolsProfile;
}

export interface Usage {
  /** TOTAL prompt tokens — cached reads and cache writes are subsets, never additive. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` served from cache. Required so adapters must state it; 0 = none. */
  cachedReadTokens: number;
  /** Subset of `inputTokens` written to cache, keyed by TTL seconds (Anthropic-style). */
  cacheWriteTokens?: Record<CacheTtlSeconds, number>;
}

// Validates the structural shape; the exact-optional `Usage` is cast at the parse site.
const tokens = z.number().int().nonnegative();
export const usageSchema = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cachedReadTokens: tokens,
  cacheWriteTokens: z.record(z.coerce.number().int().positive(), tokens).optional(),
});

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

/** Grammar constraining a freeform tool's raw string input; ignored where unsupported. */
export interface ToolGrammar {
  syntax: "lark" | "regex";
  definition: string;
}

/** The tool description a provider renders, derived by the kernel from a `Tool`'s `input`. */
export type ToolSchema =
  | {
      kind: "function";
      name: string;
      description: string;
      // JSON Schema the kernel derives from the tool's zod schema; zod stays the source of truth.
      parameters: Record<string, unknown>;
    }
  | { kind: "custom"; name: string; description: string; grammar?: ToolGrammar }
  // A provider's natively trained built-in (e.g. Claude's text_editor). The provider renders
  // it from `id` onto its versioned wire type; there is no harness-supplied JSON Schema.
  | { kind: "native"; name: string; description: string; id: NativeToolId };

export interface ModelRequest {
  instructions: ContentBlock[];
  items: { item: Item; payload?: ProviderPayload }[];
  tools?: ToolSchema[];
  /** Non-durable final user prompt, recorded with the build but never appended to the item log. */
  prompt?: string;
  /** Provider-neutral tool selection; absent is equivalent to `auto`. */
  toolChoice?: "auto" | "none";
  /** Per-request output cap; absent lets the provider use its normal default. */
  maxOutputTokens?: number;
  modelConfig: ModelConfig;
}

/** A finalized non-text model output that can be persisted and continued by the agent loop. */
export type ModelOutputItem =
  | { type: "reasoning"; content: ContentBlock[]; payload?: ProviderPayloadDraft }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      payload?: ProviderPayloadDraft;
    };

/** The completed, non-agentic result of exactly one provider invocation. */
export interface ModelInvocationResult {
  content: ContentBlock[];
  /** Ordered reasoning/tool-call outputs, including opaque provider fidelity. */
  outputItems: ModelOutputItem[];
  usage: Usage;
  modelConfig: ModelConfig;
}

/** Provider-neutral signal used for the single safe compact-and-retry path. */
export class ContextWindowExceededError extends Error {
  constructor(message = "model context window exceeded", options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextWindowExceededError";
  }
}

/**
 * A narrow caller for one model-backed operation (review, summarization, titles, …).
 * It consumes one stream; the caller decides whether finalized outputs should continue.
 */
export interface ModelInvoker {
  invoke(
    request: Omit<ModelRequest, "modelConfig"> & { modelConfig?: ModelConfig },
    options?: { purpose?: string; signal?: AbortSignal },
  ): Promise<ModelInvocationResult>;
}

// Output is carried before `completed`: text through `text_delta`, and structured
// output through finalized `reasoning`/`tool_call` events. A provider whose
// transport is non-streaming emits its complete text as one `text_delta`.
// `payload` is the item's opaque provider fidelity (round-tripped).
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
      payload?: ProviderPayloadDraft; // binds to the step's final assistant message
      usage: Usage;
    };

export interface ModelProvider {
  readonly provider: string;
  capabilities(model: string): ModelCapabilities;
  validateConfig(config: ModelConfig): void;
  /** Streams one model step. The signal aborts the underlying network stream. */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** The selectable models this provider offers (may be empty). */
  listModels(): ModelInfo[];
}

/** A point in the model-middleware chain: runs the next inner middleware, or the provider. */
export type ModelHandler = (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;

export interface ModelMiddlewareContext {
  conversationId: ConversationId;
  signal: AbortSignal;
  /**
   * The opaque `meta` bag of an offered tool by name (`undefined` if unknown / none) — tool metadata
   * the wire `ToolSchema` omits, so a request-shaping middleware can read it (e.g. inject a
   * `background` argument into `backgroundable` tools).
   */
  toolMeta(name: string): Record<string, unknown> | undefined;
}

/**
 * Wraps one model step, symmetric to `ToolMiddleware`. `next` may be called zero times
 * (short-circuit/cache), once (normal), or many (retry/fallback). Only re-issue before the
 * first yielded event — streamed events can't be un-emitted.
 */
export interface ModelMiddleware {
  readonly id: string;
  wrap(
    request: ModelRequest,
    ctx: ModelMiddlewareContext,
    next: ModelHandler,
  ): AsyncIterable<ModelStreamEvent>;
}
