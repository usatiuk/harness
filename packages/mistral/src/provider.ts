import OpenAI from "openai";
import { PRODUCT_USER_AGENT } from "@harness/release";
import type { Stream } from "openai/core/streaming";
import {
  mergeModelMetadata,
  ContextWindowExceededError,
  ModelDiscoveryError,
  sessionIdHeaders,
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
  MAX_MODELS,
  parseCatalog,
  type CatalogEntry,
  type MistralMode,
} from "./catalog.ts";
import { buildMistralRequest } from "./request.ts";
import { mistralEvents } from "./stream.ts";
import type { ConfiguredModel } from "./config.ts";

/** Native Mistral semantics; the OpenAI SDK owns only HTTP/SSE delivery. */
export class MistralProvider implements ModelProvider {
  readonly provider: string;
  readonly providerOptions: { readonly webSearch: boolean };
  readonly #mode: MistralMode;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #client: OpenAI;
  readonly #models: Readonly<Record<string, ConfiguredModel>>;
  #catalog = new Map<string, CatalogEntry>();

  constructor(
    id: string,
    mode: MistralMode,
    apiKey: string,
    fetcher: typeof fetch = fetch,
    webSearch = false,
    models: Record<string, ConfiguredModel> = {},
  ) {
    this.provider = id;
    this.providerOptions = Object.freeze({ webSearch });
    this.#mode = mode;
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#models = structuredClone(models);
    this.#catalog = this.#mergeModels(new Map());
    this.#client = new OpenAI({
      apiKey,
      baseURL: MISTRAL_BASE_URL,
      fetch: fetcher,
      maxRetries: 0,
      defaultHeaders: { "User-Agent": PRODUCT_USER_AGENT },
    });
  }
  listModels(): ModelInfo[] {
    return structuredClone([...this.#catalog.values()].map(({ info }) => info));
  }
  #mergeModels(entries: Map<string, CatalogEntry>): Map<string, CatalogEntry> {
    for (const [model, { temperature, ...configured }] of Object.entries(this.#models)) {
      const discovered = entries.get(model);
      const info = mergeModelMetadata(this.provider, discovered ? [discovered.info] : [], {
        [model]: configured,
      })[0]!;
      if (configured.reasoning?.supported === false) {
        delete info.presets;
      } else if (configured.reasoning?.effortLevels !== undefined) {
        info.presets = configured.reasoning.effortLevels.map((value) => ({ value }));
      }
      entries.set(model, {
        ...discovered,
        info,
        ...(temperature !== undefined ? { temperature } : {}),
      });
    }
    if (entries.size > MAX_MODELS)
      throw new ModelDiscoveryError(
        "limit",
        "Mistral catalog exceeds 5000 models including configured entries",
      );
    return entries;
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
    const metadata = this.#models[model];
    return {
      contentTypes: ["text", "image"],
      toolCalling: true,
      customToolInput: metadata?.customToolInput ?? { supported: false, grammars: [] },
      preferredEditTool: metadata?.preferredEditTool ?? "replace",
    };
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
    this.#catalog = this.#mergeModels(result.entries);
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
    try {
      const params = buildMistralRequest(request);
      const completionArgs = {
        ...params.completion_args,
        ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
        ...(request.modelConfig.preset !== undefined
          ? {
              reasoning_effort:
                request.modelConfig.preset === "off" ? "none" : request.modelConfig.preset,
            }
          : {}),
      };
      const stream = await this.#client.post<Stream<unknown>>("/conversations", {
        body: { ...params, completion_args: completionArgs },
        stream: true,
        signal,
        headers: { ...sessionIdHeaders(context, "x-affinity"), Accept: "text/event-stream" },
        fetchOptions: { redirect: "manual" },
      });
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
