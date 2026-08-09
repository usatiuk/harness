import OpenAI from "openai";
import type {
  PresetInfo,
  ModelConfig,
  ModelInfo,
  ModelPricing,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelCapabilities,
} from "@harness/protocol";
import { ContextWindowExceededError } from "@harness/protocol";
import type { OpenAICredentials } from "./credentials.ts";
import { buildResponseParams } from "./request.ts";
import { buildChatParams } from "./request.ts";
import { toModelEvents, toChatEvents } from "./stream.ts";

export interface OpenAIModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

/** One model in the provider catalog. */
interface ModelSpec extends OpenAIModelLimits {
  model: string;
  presets: PresetInfo[];
  /** Preset used when the selection omits one; must appear in `presets`. */
  defaultPreset: string;
  /** USD per MTok. No `cacheWrite`: OpenAI bills no cache-write premium. */
  pricing: ModelPricing;
}

const preset = (value: OpenAI.ReasoningEffort & string): PresetInfo => ({ value });

// Default medium preserves prior behavior (a fixed medium effort). See openai `ReasoningEffort`.
// Rates: developers.openai.com/api/docs/pricing, as of 2026-06.
const MODELS: ModelSpec[] = [
  {
    model: "gpt-5.1",
    presets: [preset("none"), preset("low"), preset("medium"), preset("high")],
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.25, output: 10, cachedRead: 0.125 },
  },
  {
    model: "gpt-5.5",
    presets: [preset("none"), preset("low"), preset("medium"), preset("high")],
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
    model: "gpt-5.1-codex",
    presets: [preset("low"), preset("medium"), preset("high")],
    defaultPreset: "medium",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.25, output: 10, cachedRead: 0.125 },
  },
];

/** Chosen preset if the model offers it, else its default; unknown model → `base` unchanged. */
export function reasoningForSelection(
  config: ModelConfig,
  base: OpenAI.Reasoning,
): OpenAI.Reasoning {
  const spec = MODELS.find((m) => m.model === config.model);
  if (!spec) return base;
  const offered = spec.presets.some((e) => e.value === config.preset);
  const value = (offered ? config.preset : spec.defaultPreset) as OpenAI.ReasoningEffort;
  return { ...base, effort: value };
}

export interface OpenAIProviderOptions {
  credentials: OpenAICredentials;
  /** Registry name; defaults to `"openai"`. A future OAuth package uses its own. */
  provider?: string;
  /** Reasoning effort/summary; defaults to medium effort with auto summaries. */
  reasoning?: OpenAI.Reasoning;
  /** Backend-specific capacity for models whose limits differ from the public API. */
  modelLimits?: Readonly<Record<string, OpenAIModelLimits>>;
  /** Whether this transport can send the advisory `max_output_tokens` request cap. */
  supportsMaxOutputTokens?: boolean;
}

/** A `ModelProvider` backed by the OpenAI Responses API, streaming only. */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;
  readonly #reasoning: OpenAI.Reasoning;
  readonly #modelLimits: Readonly<Record<string, OpenAIModelLimits>>;
  readonly #supportsMaxOutputTokens: boolean;

  constructor(opts: OpenAIProviderOptions) {
    this.provider = opts.provider ?? "openai";
    this.#credentials = opts.credentials;
    this.#reasoning = opts.reasoning ?? { effort: "medium", summary: "auto" };
    this.#modelLimits = opts.modelLimits ?? {};
    this.#supportsMaxOutputTokens = opts.supportsMaxOutputTokens ?? true;
  }

  capabilities(model: string): ModelCapabilities {
    void model;
    // Every GPT model this class serves is trained on the V4A apply_patch dialect.
    return { contentTypes: ["text"], toolCalling: true, fileTools: "apply_patch" };
  }

  /** Fails fast on a preset the model doesn't offer; other configs are accepted unchallenged. */
  validateConfig(config: ModelConfig): void {
    const spec = MODELS.find((m) => m.model === config.model);
    /* c8 ignore next -- no preset guard on an uncataloged model is deliberate (let the SDK say it) */
    if (!config.preset || !spec) return;
    if (!spec.presets.some((p) => p.value === config.preset)) {
      throw new Error(
        `unknown preset "${config.preset}" for ${this.provider}/${config.model} (try: ${spec.presets.map((p) => p.value).join(", ")})`,
      );
    }
  }

  listModels(): ModelInfo[] {
    return MODELS.map((m) => {
      const limits = this.#modelLimits[m.model] ?? m;
      return {
        provider: this.provider,
        model: m.model,
        presets: m.presets,
        defaultPreset: m.defaultPreset,
        contextWindow: limits.contextWindow,
        maxOutputTokens: limits.maxOutputTokens,
        pricing: m.pricing,
      };
    });
  }

  /**
   * The native request for one model step. Overridable so config-defined providers can reshape the
   * request (drop the reasoning field, apply generation presets) without forking the stream glue.
   */
  protected buildParams(request: ModelRequest): OpenAI.Responses.ResponseCreateParamsStreaming {
    const reasoning = reasoningForSelection(request.modelConfig, this.#reasoning);
    return buildResponseParams(request, reasoning, this.provider);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    try {
      const client = await this.#credentials.client();
      const params = this.buildParams(request);
      if (!this.#supportsMaxOutputTokens) delete params.max_output_tokens;
      const stream = await client.responses.create(params, { signal });
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

export interface OpenAIChatProviderOptions {
  credentials: OpenAICredentials;
  /** Registry name; defaults to `"openai-chat"`. */
  provider?: string;
}

/**
 * A `ModelProvider` backed by the OpenAI chat/completions API, streaming only.
 * Thin shell: no built-in catalog (config-defined providers supply their own via
 * `listModels`); chat always honors the advisory `max_tokens` output cap.
 */
export class OpenAIChatProvider implements ModelProvider {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;

  constructor(opts: OpenAIChatProviderOptions) {
    this.provider = opts.provider ?? "openai-chat";
    this.#credentials = opts.credentials;
  }

  capabilities(model: string): ModelCapabilities {
    void model;
    // Function-only: the chat transport cannot carry freeform custom tools, so
    // the file-editing dialect must never be apply_patch.
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" };
  }

  /** No catalog to guard presets against; unknown configs pass to the SDK. */
  validateConfig(_config: ModelConfig): void {
    void _config;
  }

  listModels(): ModelInfo[] {
    return [];
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

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    try {
      const client = await this.#credentials.client();
      const params = this.buildParams(request);
      const stream = await client.chat.completions.create(params, { signal });
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
