import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  PresetInfo,
  ModelCapabilities,
  ModelCallContext,
  ModelConfig,
  ModelInfo,
  ModelPricing,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "@harness/protocol";
import {
  ContextWindowExceededError,
  mergeModelMetadata,
  modelMetadataSchema,
} from "@harness/protocol";
import type { AnthropicCredentials } from "./credentials.ts";
import { buildMessages, type AnthropicRequestConfig } from "./request.ts";
import { toModelEvents } from "./stream.ts";

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const anthropicModelConfigSchema = modelMetadataSchema.extend({
  presets: z.array(effortSchema).optional(),
  defaultPreset: effortSchema.optional(),
  thinking: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("disabled") }),
      z.strictObject({
        type: z.literal("adaptive"),
        display: z.enum(["summarized", "omitted"]).optional(),
      }),
      z.strictObject({
        type: z.literal("enabled"),
        budget_tokens: z.number().int().min(1024),
        display: z.enum(["summarized", "omitted"]).optional(),
      }),
    ])
    .optional(),
});
export type AnthropicModelConfig = z.infer<typeof anthropicModelConfigSchema>;

type Effort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;

/** One model in the provider catalog. */
interface ModelSpec {
  model: string;
  supportsImages: boolean;
  presets: PresetInfo[];
  /** Preset used when the selection omits one; must appear in `presets`. Absent = no preset axis. */
  defaultPreset?: Effort;
  contextWindow: number;
  /**
   * The required per-request `max_tokens`, set to each model's documented max output on the
   * synchronous Messages API (no beta header — the output-300k beta is Batches-API only). We
   * always stream, so a large cap is safe; the model stops at end_turn well before it.
   */
  maxTokens: number;
  /**
   * Whether to drive adaptive thinking. Opus 4.8 and Sonnet 4.6 support it; Haiku 4.5 does NOT
   * (extended/budgeted thinking only), so sending `{type:"adaptive"}` there would be rejected.
   */
  adaptiveThinking: boolean;
  /** USD per MTok. `cacheWrite` keyed by TTL seconds (300 = 5m, 3600 = 1h). */
  pricing: ModelPricing;
}

const presets = (...values: Effort[]): PresetInfo[] => values.map((value) => ({ value }));

// Rates per the Anthropic pricing page as of 2026-06; cache writes at 5m/1h.
const MODELS: ModelSpec[] = [
  {
    model: "claude-opus-4-8",
    supportsImages: true,
    presets: presets("low", "medium", "high", "xhigh", "max"),
    defaultPreset: "high",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    adaptiveThinking: true,
    pricing: { input: 5, output: 25, cachedRead: 0.5, cacheWrite: { 300: 6.25, 3600: 10 } },
  },
  {
    model: "claude-sonnet-4-6",
    supportsImages: true,
    presets: presets("low", "medium", "high", "max"),
    defaultPreset: "high",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    adaptiveThinking: true,
    pricing: { input: 3, output: 15, cachedRead: 0.3, cacheWrite: { 300: 3.75, 3600: 6 } },
  },
  {
    model: "claude-haiku-4-5",
    supportsImages: true,
    presets: [],
    contextWindow: 200_000,
    maxTokens: 64_000,
    adaptiveThinking: false,
    pricing: { input: 1, output: 5, cachedRead: 0.1, cacheWrite: { 300: 1.25, 3600: 2 } },
  },
];

const MAX_TOKENS_FALLBACK = 8192;

export interface AnthropicProviderOptions {
  credentials: AnthropicCredentials;
  /** Registry name; defaults to `"anthropic"`. A future OAuth package uses its own. */
  provider?: string;
  webSearch?: boolean;
  modelOverrides?: Record<string, AnthropicModelConfig>;
}

/** Connection identity and credential access for the Messages wire transport. */
export interface AnthropicMessagesTransportOptions {
  credentials: AnthropicCredentials;
  provider: string;
  /** Connection-owned per-call headers; never mutate a shared SDK client's defaults. */
  requestHeaders?: (context: ModelCallContext) => Record<string, string>;
}
/** Native streaming and error normalization; concrete connections own catalog and request policy. */
export abstract class AnthropicMessagesTransport {
  readonly provider: string;
  readonly #credentials: AnthropicCredentials;
  readonly #requestHeaders: AnthropicMessagesTransportOptions["requestHeaders"];

  constructor(opts: AnthropicMessagesTransportOptions) {
    this.provider = opts.provider;
    this.#credentials = opts.credentials;
    this.#requestHeaders = opts.requestHeaders;
  }
  protected abstract buildConfig(request: ModelRequest): AnthropicRequestConfig;
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    try {
      const client = await this.#credentials.client(signal);
      const params = buildMessages(request, this.buildConfig(request), this.provider);
      const stream = await client.messages.create(params, {
        signal,
        ...(this.#requestHeaders ? { headers: this.#requestHeaders(context) } : {}),
      });
      yield* toModelEvents(stream, this.provider, request.modelConfig.model, signal);
    } catch (error) {
      const e = error as { status?: number; message?: string };
      const message = e.message ?? String(error);
      if (e.status === 400 && /context window|prompt is too long|too many tokens/i.test(message)) {
        throw new ContextWindowExceededError(message, { cause: error });
      }
      throw error;
    }
  }
}

export class AnthropicProvider extends AnthropicMessagesTransport implements ModelProvider {
  readonly providerOptions: { readonly webSearch: boolean };
  readonly #modelOverrides: Record<string, AnthropicModelConfig>;
  constructor(opts: AnthropicProviderOptions) {
    super({ credentials: opts.credentials, provider: opts.provider ?? "anthropic" });
    this.#modelOverrides = opts.modelOverrides ?? {};
    this.providerOptions = Object.freeze({ webSearch: opts.webSearch ?? false });
  }

  capabilities(model: string): ModelCapabilities {
    const metadata = this.#modelOverrides[model];
    return {
      contentTypes: ["text", "image"],
      toolCalling: true,
      customToolInput: metadata?.customToolInput ?? { supported: false, grammars: [] },
      preferredEditTool: metadata?.preferredEditTool ?? "replace",
    };
  }

  /** Fails fast on a preset the model doesn't offer; other configs are accepted unchallenged. */
  validateConfig(config: ModelConfig): void {
    const spec = this.listModels().find((m) => m.model === config.model);
    /* c8 ignore next -- no preset guard on an uncataloged model is deliberate (let the SDK say it) */
    if (!config.preset || !spec) return;
    if (!(spec.presets ?? []).some((p) => p.value === config.preset)) {
      throw new Error(
        `unknown preset "${config.preset}" for ${this.provider}/${config.model} (try: ${(spec.presets ?? []).map((p) => p.value).join(", ")})`,
      );
    }
  }

  listModels(): ModelInfo[] {
    return mergeModelMetadata(
      this.provider,
      MODELS.map((m) => ({
        provider: this.provider,
        model: m.model,
        presets: m.presets,
        supportsImages: m.supportsImages,
        ...(m.defaultPreset ? { defaultPreset: m.defaultPreset } : {}),
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxTokens,
        pricing: m.pricing,
      })),
      Object.fromEntries(
        Object.entries(this.#modelOverrides).map(([model, config]) => {
          const metadata = { ...config };
          delete metadata.presets;
          delete metadata.defaultPreset;
          delete metadata.thinking;
          return [model, metadata];
        }),
      ),
    ).map((model) => {
      const override = this.#modelOverrides[model.model];
      const presets = override?.presets?.map((value) => ({ value })) ?? model.presets;
      const inheritedDefault =
        override?.presets === undefined ||
        override.presets.some((value) => value === model.defaultPreset)
          ? model.defaultPreset
          : undefined;
      const defaultPreset = override?.defaultPreset ?? inheritedDefault;
      if (defaultPreset && !(presets ?? []).some(({ value }) => value === defaultPreset)) {
        throw new Error(
          `Default preset "${defaultPreset}" is not offered by ${this.provider}/${model.model}`,
        );
      }
      const resolved = { ...model, ...(presets ? { presets } : {}) };
      if (defaultPreset) resolved.defaultPreset = defaultPreset;
      else delete resolved.defaultPreset;
      return resolved;
    });
  }

  /**
   * The per-request knob set for one model step. Overridable so config-defined providers can
   * reshape it (drop thinking/effort, apply generation presets) without forking the stream glue.
   */
  protected buildConfig(request: ModelRequest): AnthropicRequestConfig {
    const spec = MODELS.find((m) => m.model === request.modelConfig.model);
    const model = this.listModels().find((entry) => entry.model === request.modelConfig.model);
    const preset = model?.presets?.some(({ value }) => value === request.modelConfig.preset)
      ? request.modelConfig.preset
      : model?.defaultPreset;
    const thinking =
      this.#modelOverrides[request.modelConfig.model]?.thinking ??
      (spec?.adaptiveThinking
        ? { type: "adaptive" as const, display: "summarized" as const }
        : undefined);
    return {
      maxTokens:
        request.maxOutputTokens ??
        this.#modelOverrides[request.modelConfig.model]?.maxOutputTokens ??
        spec?.maxTokens ??
        MAX_TOKENS_FALLBACK,
      // display must be explicit: Opus 4.7+ defaults to "omitted" (empty thinking text).
      ...(thinking
        ? {
            thinking:
              thinking.type === "disabled"
                ? thinking
                : { ...thinking, display: thinking.display ?? "summarized" },
          }
        : {}),
      ...(preset ? { effort: preset as Effort } : {}),
    };
  }
}
