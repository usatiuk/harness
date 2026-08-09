import { OpenAIChatProvider } from "@harness/openai-core";
import { apiKeyCredentials } from "@harness/openai-api";
import type { ModelCapabilities, ModelConfig, ModelRequest } from "@harness/protocol";
import type { CustomCompletionsModelConfig } from "@harness/config";
import { applyOpenAIPreset, type RequestParams } from "./openai-presets.ts";
import { listScopedModels, scopedModel, validateScopedConfig } from "./model-scope.ts";

export interface CustomOpenAICompletionsProviderOptions {
  /** Registry name; the config key that defined this provider. */
  id: string;
  endpoint: string;
  apiKey: string;
  /** Every model this endpoint serves, keyed by model id. Each carries its own capacity and presets. */
  models: Record<string, CustomCompletionsModelConfig>;
}

/** A chat/completions-compatible provider defined by settings rather than a compiled catalog. */
export class CustomOpenAICompletionsProvider extends OpenAIChatProvider {
  readonly #models: ReadonlyMap<string, CustomCompletionsModelConfig>;

  constructor(opts: CustomOpenAICompletionsProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#models = new Map(Object.entries(opts.models));
  }

  override capabilities(model: string): ModelCapabilities {
    return {
      contentTypes: ["text"],
      toolCalling: true,
      // Function-only transport: the schema already rejects apply_patch for every model here.
      fileTools: scopedModel(this.provider, this.#models, model).fileTools ?? "string_replace",
    };
  }

  override listModels() {
    return listScopedModels(this.provider, this.#models);
  }

  override validateConfig(config: ModelConfig): void {
    validateScopedConfig(this.provider, this.#models, config);
  }

  /** Applies the selected preset for the chosen model to the built chat request. */
  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    applyOpenAIPreset(
      params as unknown as RequestParams,
      "max_tokens",
      this.#models.get(request.modelConfig.model)?.presets?.[request.modelConfig.preset ?? ""],
    );
    if (request.maxOutputTokens !== undefined) params.max_tokens = request.maxOutputTokens;
    return params;
  }
}
