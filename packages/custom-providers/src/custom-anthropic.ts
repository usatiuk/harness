import { AnthropicProvider, type AnthropicRequestConfig } from "@harness/anthropic-core";
import { apiKeyCredentials } from "@harness/anthropic-api";
import type { ModelCapabilities, ModelConfig, ModelRequest } from "@harness/protocol";
import type { CustomAnthropicModelConfig, AnthropicPreset } from "@harness/config";
import { listScopedModels, validateScopedConfig } from "./model-scope.ts";

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
  apiKey: string;
  /** Every model this endpoint serves, keyed by model id. Each carries its own capacity and presets. */
  models: Record<string, CustomAnthropicModelConfig>;
}

/** An Anthropic Messages-compatible provider defined by settings rather than a compiled catalog. */
export class CustomAnthropicProvider extends AnthropicProvider {
  readonly #models: ReadonlyMap<string, CustomAnthropicModelConfig>;

  constructor(opts: CustomAnthropicProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#models = new Map(Object.entries(opts.models));
  }

  override capabilities(model?: string): ModelCapabilities {
    return {
      contentTypes: ["text"],
      toolCalling: true,
      // Defaults to text_editor: the Messages API's native editor profile.
      fileTools: this.#models.get(model ?? "")?.fileTools ?? "text_editor",
    };
  }

  override listModels() {
    return listScopedModels(this.provider, this.#models);
  }

  override validateConfig(config: ModelConfig): void {
    validateScopedConfig(this.provider, this.#models, config);
  }

  /**
   * Drops thinking/effort knobs (local backends reject them) and applies the configured preset for
   * the chosen model. The built-in base falls back to a hardcoded `MAX_TOKENS_FALLBACK` when the
   * model isn't in its catalog; fix that by defaulting from the chosen model's configured cap so the
   * wire cap matches the advertised `ModelInfo.maxOutputTokens` (otherwise generation is silently
   * truncated). Preset wins above all.
   */
  protected override buildConfig(request: ModelRequest) {
    const config = super.buildConfig(request);
    delete config.thinking;
    delete config.effort;
    const maxOutputTokens = this.#models.get(request.modelConfig.model)?.maxOutputTokens;
    if (maxOutputTokens !== undefined) {
      config.maxTokens = maxOutputTokens;
    }
    applyAnthropicPreset(
      config,
      this.#models.get(request.modelConfig.model)?.presets?.[request.modelConfig.preset ?? ""],
    );
    return config;
  }
}
