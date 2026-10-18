import { z } from "zod";
import type { ContentBlock } from "./content.ts";
import type { ConversationId, ItemId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { JsonValue } from "./rpc.ts";

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
  effortLevels: z.array(z.string().min(1).max(32)).max(32).optional(),
  defaultEffort: z.string().min(1).max(32).optional(),
});
export type ModelReasoningInfo = z.infer<typeof modelReasoningInfoSchema>;

/** One selectable model in a provider's catalog. */
export interface ModelInfo {
  provider: string;
  model: string;
  /** Display name; falls back to `model` when absent. */
  label?: string;
  /** Advertised model image-input support; absent means unknown, not unsupported. */
  supportsImages?: boolean;
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
  customToolInput?: CustomToolInput;
  preferredEditTool?: "patch" | "replace";
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

/** Endpoint support for raw-text tool arguments and optional generation constraints. */
export const customToolInputSchema = z
  .strictObject({
    supported: z.boolean(),
    grammars: z.array(z.enum(["lark", "regex"])),
  })
  .refine((value) => value.supported || value.grammars.length === 0, {
    message: "grammar support requires custom tool input support",
    path: ["grammars"],
  });
export type CustomToolInput = z.infer<typeof customToolInputSchema>;
export const preferredEditToolSchema = z.enum(["patch", "replace"]);

/** Shared optional metadata for additions and overrides in config.models.<id>. */
export const modelMetadataSchema = z.strictObject({
  label: z.string().trim().min(1).max(200).optional(),
  supportsImages: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: modelReasoningInfoSchema.optional(),
  customToolInput: customToolInputSchema.optional(),
  preferredEditTool: preferredEditToolSchema.optional(),
});
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;

/** Merge configured fields onto catalog entries, appending explicitly added models. */
export function mergeModelMetadata(
  provider: string,
  models: readonly ModelInfo[],
  overrides: Readonly<Record<string, ModelMetadata>>,
): ModelInfo[] {
  const merged = new Map(models.map((model) => [model.model, model]));
  for (const [model, metadata] of Object.entries(overrides)) {
    const defined = Object.fromEntries(
      Object.entries(metadata).filter(([, value]) => value !== undefined),
    );
    merged.set(model, { provider, model, ...merged.get(model), ...defined });
  }
  for (const model of merged.values()) {
    if (
      model.contextWindow !== undefined &&
      model.maxOutputTokens !== undefined &&
      model.maxOutputTokens > model.contextWindow
    ) {
      throw new Error(
        `Invalid capacity for ${provider}/${model.model}: maxOutputTokens cannot exceed contextWindow`,
      );
    }
  }
  return [...merged.values()];
}

export interface ModelCapabilities {
  contentTypes: readonly string[];
  toolCalling: boolean;
  customToolInput: CustomToolInput;
  preferredEditTool: "patch" | "replace";
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
  /** Validated, non-secret connection defaults; only the selected adapter interprets them. */
  providerOptions?: JsonValue;
}

/** Finalized model output, in emission order. Deltas are only a temporary preview. */
export type ModelOutputItem =
  | {
      type: "message";
      content: ContentBlock[];
      phase?: string | null;
      payload?: ProviderPayloadDraft;
    }
  | { type: "reasoning"; content: ContentBlock[]; payload?: ProviderPayloadDraft }
  /** Display-only activity hint. Never model input or a replayable provider payload. */
  | { type: "provider_output"; content: ContentBlock[]; payload?: never }
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
  /** Ordered finalized outputs, including opaque provider fidelity. */
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

/** Provider stream failure, or cancellation reported by a one-off invocation.
 * Configuration, persistence and core protocol-invariant errors remain ordinary exceptions. */
export class ModelInvocationFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelInvocationFailure";
  }
}

/**
 * A narrow caller for one model-backed operation (review, summarization, titles, …).
 * It consumes one stream; the caller decides whether finalized outputs should continue.
 */
export interface ModelInvoker {
  invoke(
    request: Omit<ModelRequest, "modelConfig" | "providerOptions"> & {
      modelConfig?: ModelConfig;
    },
    options?: {
      purpose?: string;
      signal?: AbortSignal;
      /** Temporary callers retain their own context; usage is still recorded. */
      persistContext?: boolean;
    },
  ): Promise<ModelInvocationResult>;
}

// Every visible block finalizes before completion. Non-streaming transports may
// emit finalized output directly. Phase describes assistant output, not loop control.
export type ModelStreamEvent =
  | { type: "text_delta"; text: string; phase?: string | null }
  | { type: "reasoning_delta"; text: string }
  | ModelOutputItem
  | {
      type: "completed";
      /** Explicitly unknown when a compatible backend omits accounting. */
      usage: Usage | null;
      /** False when billing input sums internal requests rather than measuring one prompt. */
      inputTokensAreContext?: boolean;
      /** Provider-reported billing units; opaque to the loop, safe usage data only. */
      providerUsage?: JsonValue;
      /** Additional hosted-tool charges are not included in the token rate card. */
      costIncomplete?: boolean;
      /** Terminal provider outcome that must be recorded, then fail the logical invocation. */
      error?: string;
    };

/** Invocation identity is independent of prompt content and survives logical retries. */
export interface ModelCallContext {
  readonly conversationId: ConversationId;
  /** Effective body only; never headers/credentials. Await before transport submission. */
  captureRequest?: (body: JsonValue) => Promise<void>;
}

export interface ModelProvider {
  readonly provider: string;
  /** Immutable provider-owned request defaults, copied into each request and its trace. */
  readonly providerOptions?: JsonValue;
  capabilities(model: string): ModelCapabilities;
  validateConfig(config: ModelConfig): void;
  /** Streams one model step. Abort stops network work; already received finalized
   * output and terminal accounting may drain before the stream closes. */
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
