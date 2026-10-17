import { sessionIdHeaders } from "@harness/protocol";
import { AnthropicMessagesTransport, type AnthropicRequestConfig } from "@harness/anthropic-core";
import { apiKeyCredentials } from "@harness/anthropic-api";
import type { ModelCapabilities, ModelConfig, ModelRequest } from "@harness/protocol";
import type { CustomAnthropicModelConfig, AnthropicPreset } from "./config.ts";
import { listScopedModels, scopedModel, validateScopedConfig } from "./model-scope.ts";

/** Merges one configured preset's sampling knobs onto the built Messages config. */
function applyAnthropicPreset(config: AnthropicRequestConfig, preset?: AnthropicPreset): void {
  if (!preset) return;
  if (preset.temperature !== undefined) config.temperature = preset.temperature;
  if (preset.topP !== undefined) config.topP = preset.topP;
  if (preset.maxTokens !== undefined) config.maxTokens = preset.maxTokens;
  // topK/minP/presencePenalty/repetitionPenalty aren't native to the Messages API; a local backend
  // that accepts them gets them through extra_body rather than a shaped SDK request.
  const extra: Record<string, unknown> = { ...(config.extraBody ?? {}), ...preset.extraBody };
  if (preset.topK !== undefined) extra.top_k = preset.topK;
  if (preset.minP !== undefined) extra.min_p = preset.minP;
  if (preset.presencePenalty !== undefined) extra.presence_penalty = preset.presencePenalty;
  if (preset.repetitionPenalty !== undefined) extra.repetition_penalty = preset.repetitionPenalty;
  if (Object.keys(extra).length > 0) config.extraBody = extra;
}

export interface CustomAnthropicProviderOptions {
  /** Registry name; the config key that defined this provider. */
  id: string;
  endpoint: string;
  sessionIdHeader?: string;
  apiKey: string;
  /** Every model this endpoint serves, keyed by model id. Each carries its own capacity and presets. */
  models: Record<string, CustomAnthropicModelConfig>;
}

/** An Anthropic Messages-compatible provider defined by settings rather than a compiled catalog. */
export class CustomAnthropicProvider extends AnthropicMessagesTransport {
  readonly #models: ReadonlyMap<string, CustomAnthropicModelConfig>;

  constructor(opts: CustomAnthropicProviderOptions) {
    super({
      provider: opts.id,
      requestHeaders: (context) => sessionIdHeaders(context, opts.sessionIdHeader),
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#models = new Map(Object.entries(opts.models));
  }

  capabilities(model: string): ModelCapabilities {
    return {
      contentTypes: ["text", "image"],
      toolCalling: true,
      // Defaults to text_editor: the Messages API's native editor profile.
      fileTools: scopedModel(this.provider, this.#models, model).fileTools ?? "text_editor",
    };
  }

  listModels() {
    return listScopedModels(this.provider, this.#models);
  }

  validateConfig(config: ModelConfig): void {
    validateScopedConfig(this.provider, this.#models, config);
  }

  /** Model capacity supplies the default; an invocation cap takes precedence over presets. */
  protected override buildConfig(request: ModelRequest) {
    const config: AnthropicRequestConfig = {
      maxTokens:
        scopedModel(this.provider, this.#models, request.modelConfig.model).maxOutputTokens ?? 8192,
    };
    applyAnthropicPreset(
      config,
      this.#models.get(request.modelConfig.model)?.presets?.[request.modelConfig.preset ?? ""],
    );
    if (request.maxOutputTokens !== undefined) config.maxTokens = request.maxOutputTokens;
    return config;
  }
}
