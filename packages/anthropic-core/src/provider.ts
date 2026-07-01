import type Anthropic from "@anthropic-ai/sdk";
import type {
  EffortInfo,
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelPricing,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "@harness/protocol";
import type { AnthropicCredentials } from "./credentials.ts";
import { buildMessages } from "./request.ts";
import { toModelEvents } from "./stream.ts";

type Effort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;

/** One model in the provider catalog. */
interface ModelSpec {
  model: string;
  efforts: EffortInfo[];
  /** Effort used when the selection omits one; must appear in `efforts`. Absent = no effort axis. */
  defaultEffort?: Effort;
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

const efforts = (...values: Effort[]): EffortInfo[] => values.map((value) => ({ value }));

// Rates per the Anthropic pricing page as of 2026-06; cache writes at 5m/1h.
const MODELS: ModelSpec[] = [
  {
    model: "claude-opus-4-8",
    efforts: efforts("low", "medium", "high", "xhigh", "max"),
    defaultEffort: "high",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    adaptiveThinking: true,
    pricing: { input: 5, output: 25, cachedRead: 0.5, cacheWrite: { 300: 6.25, 3600: 10 } },
  },
  {
    model: "claude-sonnet-4-6",
    efforts: efforts("low", "medium", "high", "max"),
    defaultEffort: "high",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    adaptiveThinking: true,
    pricing: { input: 3, output: 15, cachedRead: 0.3, cacheWrite: { 300: 3.75, 3600: 6 } },
  },
  {
    model: "claude-haiku-4-5",
    efforts: [],
    contextWindow: 200_000,
    maxTokens: 64_000,
    adaptiveThinking: false,
    pricing: { input: 1, output: 5, cachedRead: 0.1, cacheWrite: { 300: 1.25, 3600: 2 } },
  },
];

const MAX_TOKENS_FALLBACK = 8192;

/** Chosen effort if the model offers it, else its default; no effort axis → `undefined`. */
function effortForSelection(spec: ModelSpec, config: ModelConfig): Effort | undefined {
  if (spec.efforts.length === 0) return undefined;
  const offered = spec.efforts.some((e) => e.value === config.effort);
  return offered ? (config.effort as Effort) : spec.defaultEffort;
}

export interface AnthropicProviderOptions {
  credentials: AnthropicCredentials;
  /** Registry name; defaults to `"anthropic"`. A future OAuth package uses its own. */
  provider?: string;
}

/** A `ModelProvider` backed by the Anthropic Messages API, streaming only. */
export class AnthropicProvider implements ModelProvider {
  readonly provider: string;
  readonly #credentials: AnthropicCredentials;

  constructor(opts: AnthropicProviderOptions) {
    this.provider = opts.provider ?? "anthropic";
    this.#credentials = opts.credentials;
  }

  capabilities(): ModelCapabilities {
    // Every Claude model this class serves is trained on the native text_editor tool.
    return { contentTypes: ["text"], toolCalling: true, fileTools: "text_editor" };
  }

  validateConfig(): void {}

  listModels(): ModelInfo[] {
    return MODELS.map((m) => ({
      provider: this.provider,
      model: m.model,
      efforts: m.efforts,
      ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
      contextWindow: m.contextWindow,
      pricing: m.pricing,
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const client = await this.#credentials.client();
    const spec = MODELS.find((m) => m.model === request.modelConfig.model);
    const effort = spec ? effortForSelection(spec, request.modelConfig) : undefined;
    const params = buildMessages(
      request,
      {
        maxTokens: spec?.maxTokens ?? MAX_TOKENS_FALLBACK,
        // display must be explicit: Opus 4.7+ defaults to "omitted" (empty thinking text).
        ...(spec?.adaptiveThinking
          ? { thinking: { type: "adaptive", display: "summarized" } }
          : {}),
        ...(effort ? { effort } : {}),
      },
      this.provider,
    );
    const stream = await client.messages.create(params, { signal });
    yield* toModelEvents(stream, this.provider, request.modelConfig.model, signal);
  }
}
