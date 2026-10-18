import { jsonValueSchema, mergeModelMetadata, modelMetadataSchema } from "@harness/protocol";
import { z } from "zod";
import type OpenAI from "openai";
import type {
  PresetInfo,
  ModelConfig,
  ModelInfo,
  ModelPricing,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelCapabilities,
  ModelCallContext,
} from "@harness/protocol";
import { ContextWindowExceededError } from "@harness/protocol";
import type { OpenAICredentials } from "./credentials.ts";
import { buildResponseParams } from "./request.ts";
import { buildChatParams } from "./request.ts";
import { toModelEvents, toChatEvents } from "./stream.ts";

const effortSchema = z.string().trim().min(1).max(64);
export const openAIModelConfigSchema = modelMetadataSchema.extend({
  presets: z.array(effortSchema).optional(),
  defaultPreset: effortSchema.optional(),
});
export type OpenAIModelConfig = z.infer<typeof openAIModelConfigSchema>;

export interface OpenAIModelLimits {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** One model in the provider catalog. */
export interface OpenAIModelSpec extends OpenAIModelLimits {
  label?: string;
  customToolInput?: ModelCapabilities["customToolInput"];
  preferredEditTool?: ModelCapabilities["preferredEditTool"];
  model: string;
  supportsImages?: boolean;
  presets: PresetInfo[];
  /** Preset used when the selection omits one; must appear in `presets`. */
  defaultPreset?: string;
  /** USD per MTok, including cache-write charges on GPT-5.6 and later. */
  pricing?: ModelPricing;
}

const preset = (value: OpenAI.ReasoningEffort & string): PresetInfo => ({ value });

// Default medium preserves prior behavior (a fixed medium effort). See openai `ReasoningEffort`.
// Verified against official model pages and pricing on 2026-10-03.
const modernPresets = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const gpt6Presets = ["low", "medium", "high", "xhigh", "max"] as const;
const previousPresets = ["none", "low", "medium", "high", "xhigh"] as const;
function modernModel(
  model: string,
  input: number,
  output: number,
  cachedRead: number,
  allowNone = true,
): OpenAIModelSpec {
  return {
    model,
    supportsImages: true,
    presets: (allowNone ? modernPresets : gpt6Presets).map(preset),
    defaultPreset: "medium",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: {
      input,
      output,
      cachedRead,
      cacheWrite: { 1800: input * 1.25 },
      longContext: {
        threshold: 272_000,
        input: input * 2,
        output: output * 1.5,
        cachedRead: cachedRead * 2,
        cacheWrite: { 1800: input * 2.5 },
      },
    },
  };
}
export const OPENAI_MODELS: readonly OpenAIModelSpec[] = [
  modernModel("gpt-6.1-sol", 2, 10, 0.1, false),
  modernModel("gpt-6-astra", 10, 50, 1, false),
  modernModel("gpt-6-sol", 2, 10, 0.2),
  modernModel("gpt-6-luna", 0.1, 0.5, 0.01),
  modernModel("gpt-5.6-sol", 4, 20, 0.4),
  modernModel("gpt-5.6-terra", 2, 12, 0.2),
  modernModel("gpt-5.6-luna", 0.2, 1.2, 0.02),
  {
    model: "gpt-5.1",
    supportsImages: true,
    presets: [preset("none"), preset("low"), preset("medium"), preset("high")],
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.25, output: 10, cachedRead: 0.125 },
  },
  {
    model: "gpt-5.5",
    supportsImages: true,
    presets: previousPresets.map(preset),
    defaultPreset: "medium",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: {
      input: 5,
      output: 30,
      cachedRead: 0.5,
      longContext: { threshold: 272_000, input: 10, output: 45, cachedRead: 1 },
    },
  },
  {
    model: "gpt-5.4",
    supportsImages: true,
    presets: previousPresets.map(preset),
    defaultPreset: "medium",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: {
      input: 2.5,
      output: 15,
      cachedRead: 0.25,
      longContext: { threshold: 272_000, input: 5, output: 22.5, cachedRead: 0.5 },
    },
  },
  {
    model: "gpt-5.4-mini",
    supportsImages: true,
    presets: previousPresets.map(preset),
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.75, output: 4.5, cachedRead: 0.075 },
  },
  {
    model: "gpt-5.2",
    supportsImages: true,
    presets: previousPresets.map(preset),
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.75, output: 14, cachedRead: 0.175 },
  },
  {
    model: "gpt-5.3-codex",
    supportsImages: true,
    presets: [preset("low"), preset("medium"), preset("high"), preset("xhigh")],
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.75, output: 14, cachedRead: 0.175 },
  },
];

/** Chosen preset if the model offers it, else its default; unknown model → `base` unchanged. */
export function reasoningForSelection(
  config: ModelConfig,
  base: OpenAI.Reasoning,
  models: readonly OpenAIModelSpec[] = OPENAI_MODELS,
): OpenAI.Reasoning {
  const spec = models.find((m) => m.model === config.model);
  if (!spec) return base;
  const offered = spec.presets.some((e) => e.value === config.preset);
  const value = (offered ? config.preset : spec.defaultPreset) as OpenAI.ReasoningEffort;
  if (value) return { ...base, effort: value };
  const reasoning = { ...base };
  delete reasoning.effort;
  return reasoning;
}

export interface OpenAIProviderOptions {
  credentials: OpenAICredentials;
  /** Registry name; defaults to `"openai"`. A future OAuth package uses its own. */
  provider?: string;
  /** Reasoning effort/summary; defaults to medium effort with auto summaries. */
  reasoning?: OpenAI.Reasoning;
  /** Backend-specific catalog, including availability, reasoning controls, and capacity. */
  models?: readonly OpenAIModelSpec[];
  /** Whether this transport can send the advisory `max_output_tokens` request cap. */
  supportsMaxOutputTokens?: boolean;
  webSearch?: boolean;
  modelOverrides?: Record<string, OpenAIModelConfig>;
}

/** Connection identity and credential access for the Responses wire transport. */
export interface OpenAIResponsesTransportOptions {
  credentials: OpenAICredentials;
  provider: string;
  /** Connection-owned per-call headers; never mutate a shared SDK client's defaults. */
  requestHeaders?: (context: ModelCallContext) => Record<string, string>;
}
/** Native streaming and error normalization; concrete connections own catalog and request policy. */
export abstract class OpenAIResponsesTransport {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;
  readonly #requestHeaders: OpenAIResponsesTransportOptions["requestHeaders"];
  constructor(opts: OpenAIResponsesTransportOptions) {
    this.provider = opts.provider;
    this.#credentials = opts.credentials;
    this.#requestHeaders = opts.requestHeaders;
  }
  protected abstract buildParams(
    request: ModelRequest,
  ): OpenAI.Responses.ResponseCreateParamsStreaming;
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    try {
      const client = await this.#credentials.client(signal);
      const params = this.buildParams(request);
      params.prompt_cache_key = context.conversationId;
      await context.captureRequest?.(jsonValueSchema.parse(JSON.parse(JSON.stringify(params))));
      const stream = await client.responses.create(params, {
        signal,
        ...(this.#requestHeaders ? { headers: this.#requestHeaders(context) } : {}),
      });
      yield* toModelEvents(stream, this.provider, request.modelConfig.model, signal);
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      const message = e.message ?? String(error);
      if (
        e.status === 400 &&
        (e.code === "context_length_exceeded" ||
          /context (window|length)|too many tokens/i.test(message))
      ) {
        throw new ContextWindowExceededError(message, { cause: error });
      }
      throw error;
    }
  }
}

export class OpenAIResponsesProvider extends OpenAIResponsesTransport implements ModelProvider {
  readonly providerOptions: { readonly webSearch: boolean };
  readonly #reasoning: OpenAI.Reasoning;
  #models: readonly OpenAIModelSpec[];
  readonly #modelOverrides: Record<string, OpenAIModelConfig>;
  readonly #supportsMaxOutputTokens: boolean;

  constructor(opts: OpenAIProviderOptions) {
    super({
      credentials: opts.credentials,
      provider: opts.provider ?? "openai",
    });
    this.#reasoning = opts.reasoning ?? { effort: "medium", summary: "auto" };
    this.#models = opts.models ?? OPENAI_MODELS;
    this.#modelOverrides = opts.modelOverrides ?? {};
    this.#supportsMaxOutputTokens = opts.supportsMaxOutputTokens ?? true;
    this.providerOptions = Object.freeze({ webSearch: opts.webSearch ?? false });
  }

  capabilities(model: string): ModelCapabilities {
    const spec = this.#models.find((entry) => entry.model === model);
    const metadata = this.#modelOverrides[model];
    const known = OPENAI_MODELS.some((entry) => entry.model === model);
    return {
      contentTypes: ["text", "image"],
      toolCalling: true,
      customToolInput: metadata?.customToolInput ??
        spec?.customToolInput ?? { supported: known, grammars: known ? ["lark", "regex"] : [] },
      preferredEditTool:
        metadata?.preferredEditTool ?? spec?.preferredEditTool ?? (known ? "patch" : "replace"),
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

  protected replaceModels(models: readonly OpenAIModelSpec[]): void {
    this.#models = models;
  }

  listModels(): ModelInfo[] {
    return mergeModelMetadata(
      this.provider,
      this.#models.map((m) => {
        return {
          provider: this.provider,
          model: m.model,
          ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
          ...(m.label ? { label: m.label } : {}),
          presets: m.presets,
          ...(m.defaultPreset ? { defaultPreset: m.defaultPreset } : {}),
          ...(m.customToolInput ? { customToolInput: m.customToolInput } : {}),
          ...(m.preferredEditTool ? { preferredEditTool: m.preferredEditTool } : {}),
          ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
          ...(m.maxInputTokens === undefined ? {} : { maxInputTokens: m.maxInputTokens }),
          ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
          ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
        };
      }),
      Object.fromEntries(
        Object.entries(this.#modelOverrides).map(([model, config]) => {
          const metadata = { ...config };
          delete metadata.presets;
          delete metadata.defaultPreset;
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

  /** Direct OpenAI/Codex generation policy over the native Responses mapper. */
  protected buildParams(request: ModelRequest): OpenAI.Responses.ResponseCreateParamsStreaming {
    const reasoning = reasoningForSelection(
      request.modelConfig,
      this.#reasoning,
      this.listModels().map((model) => ({
        ...model,
        presets: model.presets ?? [],
      })),
    );
    const params = buildResponseParams(request, reasoning, this.provider, true);
    if (!this.#supportsMaxOutputTokens) delete params.max_output_tokens;
    return params;
  }
}

export interface OpenAIChatTransportOptions {
  credentials: OpenAICredentials;
  /** Outer connection identity, retained on opaque payloads. */
  provider: string;
  requestHeaders?: (context: ModelCallContext) => Record<string, string>;
}

/** Chat Completions serialization and streaming; connections own catalog and policy. */
export class OpenAIChatTransport {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;
  readonly #requestHeaders: OpenAIChatTransportOptions["requestHeaders"];

  constructor(opts: OpenAIChatTransportOptions) {
    this.provider = opts.provider;
    this.#credentials = opts.credentials;
    this.#requestHeaders = opts.requestHeaders;
  }

  /**
   * The native request for one model step. Overridable so config-defined providers
   * can reshape it (apply generation presets) without forking the stream glue.
   */
  protected buildParams(
    request: ModelRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
    return buildChatParams(request);
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    try {
      const client = await this.#credentials.client(signal);
      const params = this.buildParams(request);
      params.prompt_cache_key = context.conversationId;
      await context.captureRequest?.(jsonValueSchema.parse(JSON.parse(JSON.stringify(params))));
      const stream = await client.chat.completions.create(params, {
        signal,
        ...(this.#requestHeaders ? { headers: this.#requestHeaders(context) } : {}),
      });
      yield* toChatEvents(stream, this.provider, request.modelConfig.model, signal);
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      const message = e.message ?? String(error);
      if (
        e.status === 400 &&
        (e.code === "context_length_exceeded" ||
          /context (window|length)|too many tokens/i.test(message))
      ) {
        throw new ContextWindowExceededError(message, { cause: error });
      }
      throw error;
    }
  }
}
