import OpenAI from "openai";
import {
  ContextWindowExceededError,
  type ModelCallContext,
  type ModelCapabilities,
  type ModelConfig,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";
import {
  fetchCatalog,
  MISTRAL_BASE_URL,
  parseCatalog,
  REASONING_EFFORT,
  type CatalogEntry,
  type MistralMode,
  type ReasoningPreset,
} from "./catalog.ts";
import { buildMistralRequest } from "./request.ts";
import { mistralEvents } from "./stream.ts";

/** Native Mistral semantics; the OpenAI SDK owns only HTTP/SSE delivery. */
export class MistralProvider implements ModelProvider {
  readonly provider: string;
  readonly #mode: MistralMode;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #client: OpenAI;
  #catalog = new Map<string, CatalogEntry>();

  constructor(id: string, mode: MistralMode, apiKey: string, fetcher: typeof fetch = fetch) {
    this.provider = id;
    this.#mode = mode;
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#client = new OpenAI({
      apiKey,
      baseURL: MISTRAL_BASE_URL,
      fetch: fetcher,
      maxRetries: 0,
      defaultHeaders: { "User-Agent": "Harness/0.0.0" },
    });
  }
  listModels(): ModelInfo[] {
    return structuredClone([...this.#catalog.values()].map(({ info }) => info));
  }
  #entry(model: string): CatalogEntry {
    const entry = this.#catalog.get(model);
    if (!entry)
      throw new Error(
        `Unknown or unavailable model '${model}' for provider instance '${this.provider}'`,
      );
    return entry;
  }
  capabilities(model: string): ModelCapabilities {
    this.#entry(model);
    // Harness's canonical content currently supports text only.
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" };
  }
  validateConfig(config: ModelConfig): void {
    if (config.provider !== this.provider) throw new Error("Provider instance identity mismatch");
    const entry = this.#entry(config.model);
    if (
      config.preset !== undefined &&
      !entry.info.presets?.some(({ value }) => value === config.preset)
    )
      throw new Error(`Unknown preset '${config.preset}' for ${this.provider}/${config.model}`);
  }
  async refreshModels(signal: AbortSignal) {
    const result = parseCatalog(
      await fetchCatalog(this.#mode, this.#apiKey, signal, this.#fetch),
      this.#mode,
      this.provider,
    );
    signal.throwIfAborted();
    this.#catalog = result.entries;
    return {
      status: result.diagnostics.length ? ("degraded" as const) : ("ready" as const),
      diagnostics: result.diagnostics,
    };
  }
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    this.validateConfig(request.modelConfig);
    const entry = this.#entry(request.modelConfig.model);
    const params = {
      ...buildMistralRequest(request),
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(request.modelConfig.preset !== undefined
        ? {
            reasoning_effort: REASONING_EFFORT[request.modelConfig.preset as ReasoningPreset],
          }
        : {}),
    };
    try {
      const stream = await this.#client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        {
          signal,
          headers: { "x-affinity": context.conversationId },
          fetchOptions: { redirect: "manual" },
        },
      );
      yield* mistralEvents(stream, this.provider, request.modelConfig.model, signal);
    } catch (error) {
      if (signal.aborted && (error === signal.reason || error instanceof OpenAI.APIUserAbortError))
        signal.throwIfAborted();
      if (
        error instanceof OpenAI.APIError &&
        error.status === 400 &&
        (error.code === "context_length_exceeded" ||
          /context (window|length)|too many tokens/i.test(error.message))
      )
        throw new ContextWindowExceededError("Mistral context window exceeded", { cause: error });
      throw error;
    }
  }
}
