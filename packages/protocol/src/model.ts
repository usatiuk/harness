import { z } from "zod";
import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
import type { Item } from "./items.ts";

export interface ModelIdentity {
  provider: string;
  model: string;
}

/** Input for an identity change. Presets are changed only through the preset-specific API. */
export type ModelIdentityChange = ModelIdentity & { preset?: never };

/** One atomic model selection. A preset is meaningful only for this exact identity. */
export interface ModelConfig extends ModelIdentity {
  /** Provider-opaque preset token (e.g. reasoning effort, a sampling preset); absent = the model's default. */
  preset?: string;
}

/** One preset a model offers. The `value` is opaque to everything but the provider, which maps it
 * to its own generation parameters (reasoning effort for built-ins; temperature/topP/etc. for
 * config-defined custom providers). */
export interface PresetInfo {
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

/** Explicit advertised reasoning capabilities; absence means unknown, not unsupported. */
export const modelReasoningInfoSchema = z.strictObject({
  supported: z.boolean().optional(),
  adaptiveThinking: z.boolean().optional(),
  legacyThinking: z.boolean().optional(),
  alwaysOn: z.boolean().optional(),
  effortLevels: z.array(z.string().min(1).max(32)).min(1).max(32).optional(),
  defaultEffort: z.string().min(1).max(32).optional(),
});
export type ModelReasoningInfo = z.infer<typeof modelReasoningInfoSchema>;

/** One selectable model in a provider's catalog. */
export interface ModelInfo {
  provider: string;
  model: string;
  /** Display name; falls back to `model` when absent. */
  label?: string;
  /** Presets this model offers, in display order. Absent/empty = no preset axis. */
  presets?: PresetInfo[];
  /** Preset used when none is chosen; must be one of `presets` when present. */
  defaultPreset?: string;
  /** Max context size in tokens; absent = unknown. */
  contextWindow?: number;
  /** Separate hard input limit; it does not establish a combined context window. */
  maxInputTokens?: number;
  /** Maximum output reservation used when deciding whether the next input still fits. */
  maxOutputTokens?: number;
  reasoning?: ModelReasoningInfo;
  /** Absent = cost not computable for this model. */
  pricing?: ModelPricing;
}

/** Canonical id for a model (ignores preset): `provider/model`. */
export const modelId = (m: { provider: string; model: string }): string =>
  `${m.provider}/${m.model}`;

/** Catalog lookup by provider + model (ignores preset). */
export const findModel = (
  models: ModelInfo[],
  m: { provider: string; model: string },
): ModelInfo | undefined => models.find((x) => x.provider === m.provider && x.model === m.model);

/** Full selection id including preset when set: `provider/model[/preset]`. */
export const selectionId = (m: ModelConfig): string =>
  m.preset ? `${modelId(m)}/${m.preset}` : modelId(m);

/**
 * The file-editing tool profile a model is trained on — one indivisible choice that selects
 * the whole edit/read/write roster, so nonsense combinations can't be expressed.
 * `string_replace` is the neutral default; `apply_patch` is OpenAI's V4A; `text_editor` is the
 * Claude-style editor profile. The workspace plugin owns every profile's concrete tools.
 */
export const FILE_TOOLS = ["string_replace", "apply_patch", "text_editor"] as const;
export type FileToolsProfile = (typeof FILE_TOOLS)[number];

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
  | { kind: "custom"; name: string; description: string; grammar?: ToolGrammar };

export interface ModelRequest {
  instructions: ContentBlock[];
  items: { item: Item; payload?: ProviderPayload }[];
  tools?: ToolSchema[];
  /** Non-durable final user prompt, recorded with the build but never appended to the item log. */
  prompt?: string;
  /** Provider-neutral tool selection; absent is equivalent to `auto`. */
  toolChoice?: "auto" | "none";
  /** Advisory per-request output cap; providers honor it when their transport supports one. */
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
  /** `null` when a compatible backend completed without reporting token accounting. */
  usage: Usage | null;
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
      /** Explicitly unknown when a compatible backend omits accounting. */
      usage: Usage | null;
      /** Terminal provider outcome that must be recorded, then fail the logical invocation. */
      error?: string;
    };

/** Invocation identity is independent of prompt content and survives logical retries. */
export interface ModelCallContext {
  readonly conversationId: ConversationId;
}

export interface ModelProvider {
  readonly provider: string;
  capabilities(model: string): ModelCapabilities;
  validateConfig(config: ModelConfig): void;
  /** Streams one model step. The signal aborts the underlying network stream. */
  stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent>;
  /** The selectable models this provider offers (may be empty). */
  listModels(): ModelInfo[];
  /** Replace the discovered snapshot; synchronous reads never perform network I/O. */
  refreshModels?(
    signal: AbortSignal,
  ): Promise<import("./provider-instance.ts").ModelCatalogRefresh>;
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
