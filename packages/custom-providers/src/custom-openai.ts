import { OpenAIResponsesProvider } from "@harness/openai-core";
import { apiKeyCredentials } from "@harness/openai-api";
import type { ContentBlock, ModelCapabilities, ModelConfig, ModelRequest } from "@harness/protocol";
import type { CustomOpenAIModelConfig } from "@harness/config";
import { applyOpenAIPreset, type RequestParams } from "./openai-presets.ts";
import { listScopedModels, scopedModel, validateScopedConfig } from "./model-scope.ts";

/** Joins the textual blocks of an instructions list, mirroring the core mapping. */
const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

export interface CustomOpenAIProviderOptions {
  /** Registry name; the config key that defined this provider. */
  id: string;
  endpoint: string;
  apiKey: string;
  /** Every model this endpoint serves, keyed by model id. Each carries its own capacity and presets. */
  models: Record<string, CustomOpenAIModelConfig>;
  /**
   * Backends that silently drop Responses `instructions` (e.g. OVMS) get the system context as a
   * leading `system` input message instead. Off by default; only backends known to ignore the field
   * should opt in.
   */
  sendInstructionsAsSystem?: boolean;
}

/** An OpenAI Responses-compatible provider defined by settings rather than a compiled catalog. */
export class CustomOpenAIProvider extends OpenAIResponsesProvider {
  readonly #models: ReadonlyMap<string, CustomOpenAIModelConfig>;
  readonly #sendInstructionsAsSystem: boolean;

  constructor(opts: CustomOpenAIProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#models = new Map(Object.entries(opts.models));
    this.#sendInstructionsAsSystem = opts.sendInstructionsAsSystem ?? false;
  }

  override capabilities(model: string): ModelCapabilities {
    return {
      contentTypes: ["text"],
      toolCalling: true,
      // Defaults to string_replace: the safe function-only dialect for every OpenAI endpoint.
      fileTools: scopedModel(this.provider, this.#models, model).fileTools ?? "string_replace",
    };
  }

  override listModels() {
    return listScopedModels(this.provider, this.#models);
  }

  override validateConfig(config: ModelConfig): void {
    validateScopedConfig(this.provider, this.#models, config);
  }

  /**
   * Drops the reasoning field (many local backends reject it) and applies the configured preset.
   * When `sendInstructionsAsSystem` is set, the system context is delivered as a leading `system`
   * input message instead of the top-level `instructions` field — for backends that silently drop it.
   */
  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    delete params.reasoning;
    if (this.#sendInstructionsAsSystem && params.instructions && Array.isArray(params.input)) {
      const system = textOf(request.instructions);
      if (system) {
        delete params.instructions;
        params.input = [{ role: "system", content: system }, ...params.input];
      }
    }
    applyOpenAIPreset(
      params as unknown as RequestParams,
      "max_output_tokens",
      this.#models.get(request.modelConfig.model)?.presets?.[request.modelConfig.preset ?? ""],
    );
    if (request.maxOutputTokens !== undefined) params.max_output_tokens = request.maxOutputTokens;
    return params;
  }
}
