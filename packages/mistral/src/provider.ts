import OpenAI from "openai";
import { PRODUCT_USER_AGENT } from "@harness/release";
import { buildResponseParams, OpenAIResponsesTransport } from "@harness/openai-core";
import {
  mergeModelMetadata,
  ModelDiscoveryError,
  sessionIdHeaders,
  type ModelCapabilities,
  type ModelConfig,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
} from "@harness/protocol";
import {
  fetchCatalog,
  MISTRAL_BASE_URL,
  MAX_MODELS,
  parseCatalog,
  type CatalogEntry,
  type MistralMode,
} from "./catalog.ts";
import type { ConfiguredModel } from "./config.ts";

export class MistralProvider extends OpenAIResponsesTransport implements ModelProvider {
  readonly #mode: MistralMode;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #models: Readonly<Record<string, ConfiguredModel>>;
  #catalog = new Map<string, CatalogEntry>();

  constructor(
    id: string,
    mode: MistralMode,
    apiKey: string,
    fetcher: typeof fetch = fetch,
    models: Record<string, ConfiguredModel> = {},
  ) {
    const client = new OpenAI({
      apiKey,
      baseURL: MISTRAL_BASE_URL,
      fetch: fetcher,
      maxRetries: 0,
      defaultHeaders: { "User-Agent": PRODUCT_USER_AGENT },
      fetchOptions: { redirect: "manual" },
    });
    super({
      provider: id,
      credentials: { client: async () => client },
      requestHeaders: (context) => ({
        ...sessionIdHeaders(context, "x-affinity"),
        Accept: "text/event-stream",
      }),
    });
    this.#mode = mode;
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#models = structuredClone(models);
    this.#catalog = this.#mergeModels(new Map());
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
  protected buildParams(request: ModelRequest): OpenAI.Responses.ResponseCreateParamsStreaming {
    this.validateConfig(request.modelConfig);
    const entry = this.#entry(request.modelConfig.model);
    if (request.tools?.some((tool) => tool.kind !== "function"))
      throw new Error("Mistral supports function tools only");
    const responseRequest = { ...request };
    delete responseRequest.providerOptions;
    const { preset } = request.modelConfig;
    const effort = preset === "off" ? "none" : (preset as OpenAI.ReasoningEffort | undefined);
    const params = buildResponseParams(
      responseRequest,
      effort === undefined ? undefined : { effort },
      this.provider,
      false,
    );
    if (entry.temperature !== undefined) params.temperature = entry.temperature;
    return params;
  }
}
