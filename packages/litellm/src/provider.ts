import {
  ModelDiscoveryError,
  type ModelCapabilities,
  type ModelCallContext,
  type ModelConfig,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";
import { apiKeyCredentials as openaiCredentials } from "@harness/openai-api";
import { apiKeyCredentials as anthropicCredentials } from "@harness/anthropic-api";
import { gatewayAdapter } from "./adapters.ts";
import {
  validateProfile,
  type LiteLLMConfig,
  type ModelProfile,
  type Transport,
} from "./config.ts";
import {
  enrichModels,
  fetchCatalogJson,
  gatewayUrl,
  MAX_MODELS,
  parseIndex,
  type DiscoveredModel,
} from "./discovery.ts";

interface Entry {
  info: ModelInfo;
  profile: ModelProfile;
  transport: Transport;
  adapter: Pick<ModelProvider, "stream">;
}

export class LiteLLMProvider implements ModelProvider {
  readonly provider: string;
  readonly #config: LiteLLMConfig;
  readonly #apiKey: string;
  readonly #openai;
  readonly #anthropic;
  #catalog: ReadonlyMap<string, Entry>;

  constructor(id: string, config: LiteLLMConfig, apiKey: string) {
    this.provider = id;
    this.#config = config;
    this.#apiKey = apiKey;
    this.#openai = openaiCredentials({ apiKey, baseURL: gatewayUrl(config.baseUrl, "v1") });
    this.#anthropic = anthropicCredentials({ apiKey, baseURL: config.baseUrl.replace(/\/+$/, "") });
    this.#catalog = this.#resolve([], []);
  }

  listModels(): ModelInfo[] {
    return structuredClone([...this.#catalog.values()].map((entry) => entry.info));
  }
  capabilities(model: string): ModelCapabilities {
    const entry = this.#entry(model);
    return {
      contentTypes: ["text"],
      toolCalling: true,
      fileTools: entry.profile.fileTools ?? "string_replace",
    };
  }
  validateConfig(config: ModelConfig): void {
    if (config.provider !== this.provider) throw new Error("Provider instance identity mismatch");
    const entry = this.#entry(config.model);
    if (config.preset && !Object.hasOwn(entry.profile.presets ?? {}, config.preset))
      throw new Error(`Unknown preset '${config.preset}' for ${this.provider}/${config.model}`);
  }
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    context: ModelCallContext,
  ): AsyncIterable<ModelStreamEvent> {
    this.validateConfig(request.modelConfig);
    const entry = this.#entry(request.modelConfig.model);
    for (const { payload } of request.items) {
      if (
        !payload ||
        payload.provider !== this.provider ||
        payload.model !== request.modelConfig.model
      )
        continue;
      if (
        (payload.type === "reasoning" && entry.transport !== "openai-responses") ||
        (payload.type === "thinking" && entry.transport !== "anthropic-messages")
      )
        throw new Error(
          `Saved reasoning for ${this.provider}/${request.modelConfig.model} requires its original transport; configure the model profile before continuing`,
        );
      if ((payload.type === "reasoning" || payload.type === "thinking") && payload.version !== 1)
        throw new Error("Saved reasoning payload version is not supported");
      if (payload.type === "thinking") {
        const preset = request.modelConfig.preset ?? entry.profile.defaultPreset;
        const thinking =
          (preset ? entry.profile.presets?.[preset]?.thinking : undefined) ??
          entry.profile.thinking;
        if (!thinking || thinking.type === "disabled")
          throw new Error(
            "Saved thinking requires an enabled thinking model profile before continuing",
          );
      }
    }
    yield* entry.adapter.stream(request, signal, context);
  }

  async refreshModels(signal: AbortSignal) {
    const ids = parseIndex(
      await fetchCatalogJson(gatewayUrl(this.#config.baseUrl, "v1/models"), this.#apiKey, signal),
    );
    let models: DiscoveredModel[] = ids.map((id) => ({ id, profile: {}, supported: true }));
    const diagnostics: string[] = [];
    const enrichment = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    try {
      const enriched = enrichModels(
        [...new Set([...ids, ...Object.keys(this.#config.models)])],
        await fetchCatalogJson(
          gatewayUrl(this.#config.baseUrl, "model/info"),
          this.#apiKey,
          enrichment,
        ),
      );
      models = enriched.models;
      diagnostics.push(...enriched.diagnostics);
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      if (enrichment.aborted && error === enrichment.reason)
        diagnostics.push("Model metadata request timed out");
      else if (error instanceof ModelDiscoveryError) diagnostics.push(error.message);
      else throw error;
    }
    const catalog = this.#resolve(models, diagnostics);
    signal.throwIfAborted();
    this.#catalog = catalog;
    return { status: diagnostics.length ? ("degraded" as const) : ("ready" as const), diagnostics };
  }

  #entry(model: string): Entry {
    const entry = this.#catalog.get(model);
    if (!entry)
      throw new Error(
        `Unknown or unavailable model '${model}' for provider instance '${this.provider}'`,
      );
    return entry;
  }
  #resolve(models: DiscoveredModel[], diagnostics: string[]): ReadonlyMap<string, Entry> {
    const remote = new Map(models.map((model) => [model.id, model]));
    const ids = new Set([...remote.keys(), ...Object.keys(this.#config.models)]);
    if (ids.size > MAX_MODELS)
      throw new ModelDiscoveryError("limit", "Resolved catalog exceeds 5000 models");
    const entries = new Map<string, Entry>();
    for (const id of ids) {
      const discovered = remote.get(id);
      const configured = Object.hasOwn(this.#config.models, id)
        ? this.#config.models[id]
        : undefined;
      if (discovered?.supported === false && configured?.codingCompatible !== true) continue;
      let profile: ModelProfile = { ...discovered?.profile, ...configured };
      if (
        configured?.presets &&
        configured.defaultPreset === undefined &&
        profile.defaultPreset &&
        !Object.hasOwn(configured.presets, profile.defaultPreset)
      )
        delete profile.defaultPreset;
      let transport = profile.transport ?? this.#config.defaultTransport;
      if (profile.presets === undefined && profile.reasoning?.effortLevels !== undefined) {
        const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
        profile = {
          ...profile,
          presets: Object.fromEntries(
            efforts
              .filter(
                (effort) =>
                  profile.reasoning!.effortLevels!.includes(effort) &&
                  (transport !== "anthropic-messages" || !["none", "minimal"].includes(effort)),
              )
              .map((effort) => [effort, { reasoningEffort: effort }]),
          ),
        };
        const defaultEffort = profile.reasoning?.defaultEffort;
        if (
          profile.defaultPreset === undefined &&
          defaultEffort &&
          Object.hasOwn(profile.presets!, defaultEffort)
        )
          profile.defaultPreset = defaultEffort;
      }
      try {
        validateProfile(profile, transport);
      } catch {
        // Conflicting remote claims cannot invalidate a locally validated connection.
        diagnostics.push(`Model '${id}' has incompatible metadata; using configured defaults`);
        profile = configured ?? {};
        transport = profile.transport ?? this.#config.defaultTransport;
        validateProfile(profile, transport);
      }
      const info: ModelInfo = {
        provider: this.provider,
        model: id,
        ...(profile.label ? { label: profile.label } : {}),
        ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
        ...(profile.maxInputTokens !== undefined ? { maxInputTokens: profile.maxInputTokens } : {}),
        ...(profile.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
        ...(profile.reasoning ? { reasoning: profile.reasoning } : {}),
        ...(profile.pricing
          ? {
              pricing: {
                input: profile.pricing.input,
                output: profile.pricing.output,
                ...(profile.pricing.cachedRead !== undefined
                  ? { cachedRead: profile.pricing.cachedRead }
                  : {}),
                ...(profile.pricing.cacheWrite ? { cacheWrite: profile.pricing.cacheWrite } : {}),
              },
            }
          : {}),
        presets: Object.keys(profile.presets ?? {}).map((value) => ({ value })),
        ...(profile.defaultPreset ? { defaultPreset: profile.defaultPreset } : {}),
      };
      entries.set(id, {
        info,
        profile,
        transport,
        adapter: gatewayAdapter(transport, profile, this.provider, this.#openai, this.#anthropic),
      });
    }
    return entries;
  }
}
