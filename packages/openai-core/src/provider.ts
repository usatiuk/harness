import OpenAI from "openai";
import type {
  EffortInfo,
  ModelConfig,
  ModelInfo,
  ModelPricing,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelCapabilities,
} from "@harness/protocol";
import type { OpenAICredentials } from "./credentials.ts";
import { buildResponseParams } from "./request.ts";
import { toModelEvents } from "./stream.ts";

/** One model in the provider catalog. */
interface ModelSpec {
  model: string;
  efforts: EffortInfo[];
  /** Effort used when the selection omits one; must appear in `efforts`. */
  defaultEffort: string;
  /** Max context tokens. */
  contextWindow: number;
  /** USD per MTok. No `cacheWrite`: OpenAI bills no cache-write premium. */
  pricing: ModelPricing;
}

const effort = (value: OpenAI.ReasoningEffort & string): EffortInfo => ({ value });

// Default medium preserves prior behavior (a fixed medium effort). See openai `ReasoningEffort`.
// Rates: developers.openai.com/api/docs/pricing, as of 2026-06.
const MODELS: ModelSpec[] = [
  {
    model: "gpt-5.1",
    efforts: [effort("none"), effort("low"), effort("medium"), effort("high")],
    defaultEffort: "medium",
    contextWindow: 400_000,
    pricing: { input: 1.25, output: 10, cachedRead: 0.125 },
  },
  {
    model: "gpt-5.5",
    efforts: [effort("none"), effort("low"), effort("medium"), effort("high")],
    defaultEffort: "medium",
    contextWindow: 1_050_000,
    pricing: {
      input: 5,
      output: 30,
      cachedRead: 0.5,
      longContext: { threshold: 272_000, input: 10, output: 45, cachedRead: 1 },
    },
  },
  {
    model: "gpt-5.1-codex",
    efforts: [effort("low"), effort("medium"), effort("high")],
    defaultEffort: "medium",
    contextWindow: 400_000,
    pricing: { input: 1.25, output: 10, cachedRead: 0.125 },
  },
];

/** Chosen effort if the model offers it, else its default; unknown model → `base` unchanged. */
export function reasoningForSelection(
  config: ModelConfig,
  base: OpenAI.Reasoning,
): OpenAI.Reasoning {
  const spec = MODELS.find((m) => m.model === config.model);
  if (!spec) return base;
  const offered = spec.efforts.some((e) => e.value === config.effort);
  const value = (offered ? config.effort : spec.defaultEffort) as OpenAI.ReasoningEffort;
  return { ...base, effort: value };
}

export interface OpenAIProviderOptions {
  credentials: OpenAICredentials;
  /** Registry name; defaults to `"openai"`. A future OAuth package uses its own. */
  provider?: string;
  /** Reasoning effort/summary; defaults to medium effort with auto summaries. */
  reasoning?: OpenAI.Reasoning;
}

/** A `ModelProvider` backed by the OpenAI Responses API, streaming only. */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly provider: string;
  readonly #credentials: OpenAICredentials;
  readonly #reasoning: OpenAI.Reasoning;

  constructor(opts: OpenAIProviderOptions) {
    this.provider = opts.provider ?? "openai";
    this.#credentials = opts.credentials;
    this.#reasoning = opts.reasoning ?? { effort: "medium", summary: "auto" };
  }

  capabilities(): ModelCapabilities {
    // Every GPT model this class serves is trained on the V4A apply_patch dialect.
    return { contentTypes: ["text"], toolCalling: true, editFormat: "v4a" };
  }

  validateConfig(): void {}

  listModels(): ModelInfo[] {
    return MODELS.map((m) => ({
      provider: this.provider,
      model: m.model,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
      contextWindow: m.contextWindow,
      pricing: m.pricing,
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const client = await this.#credentials.client();
    const reasoning = reasoningForSelection(request.modelConfig, this.#reasoning);
    const stream = await client.responses.create(
      buildResponseParams(request, reasoning, this.provider),
      { signal },
    );
    yield* toModelEvents(stream, this.provider, request.modelConfig.model, signal);
  }
}
