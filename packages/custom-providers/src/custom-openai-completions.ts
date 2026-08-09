import { OpenAIChatProvider } from "@harness/openai-core";
import { apiKeyCredentials } from "@harness/openai-api";
import type {
  FileToolsProfile,
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelRequest,
} from "@harness/protocol";
import type { OpenAIPreset } from "@harness/config";

/** Loose view of the SDK request so presets can touch freeform extra fields. */
type RequestParams = Record<string, unknown>;

/** Merges one configured preset's sampling knobs onto the built chat request. */
function applyChatPreset(params: RequestParams, preset?: OpenAIPreset): void {
  if (!preset) return;
  if (preset.temperature !== undefined) params.temperature = preset.temperature;
  if (preset.topP !== undefined) params.top_p = preset.topP;
  // Chat/completions uses `max_tokens` (not Responses' `max_output_tokens`).
  if (preset.maxTokens !== undefined) params.max_tokens = preset.maxTokens;
  if (preset.frequencyPenalty !== undefined) params.frequency_penalty = preset.frequencyPenalty;
  if (preset.presencePenalty !== undefined) params.presence_penalty = preset.presencePenalty;
  Object.assign(params, preset.extraBody);
}

export interface CustomOpenAICompletionsProviderOptions {
  /** Registry name; the config key that defined this provider. */
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  presets?: Record<string, OpenAIPreset>;
  /** File-editing dialect; defaults to `string_replace` (the chat path is function-only). */
  fileTools?: FileToolsProfile;
}

/** A chat/completions-compatible provider defined by settings rather than a compiled catalog. */
export class CustomOpenAICompletionsProvider extends OpenAIChatProvider {
  readonly #model: string;
  readonly #contextWindow: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #presets: Record<string, OpenAIPreset>;
  readonly #fileTools: FileToolsProfile;

  constructor(opts: CustomOpenAICompletionsProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#model = opts.model;
    this.#contextWindow = opts.contextWindow;
    this.#maxOutputTokens = opts.maxOutputTokens;
    this.#presets = opts.presets ?? {};
    this.#fileTools = opts.fileTools ?? "string_replace";
  }

  override capabilities(): ModelCapabilities {
    return { contentTypes: ["text"], toolCalling: true, fileTools: this.#fileTools };
  }

  override listModels(): ModelInfo[] {
    return [
      {
        provider: this.provider,
        model: this.#model,
        presets: Object.keys(this.#presets).map((value) => ({ value })),
        ...(this.#contextWindow !== undefined ? { contextWindow: this.#contextWindow } : {}),
        ...(this.#maxOutputTokens !== undefined ? { maxOutputTokens: this.#maxOutputTokens } : {}),
      },
    ];
  }

  /** Fails fast on a preset the provider doesn't define; absent preset = the endpoint's default. */
  override validateConfig(config: ModelConfig): void {
    if (config.preset && !(config.preset in this.#presets)) {
      throw new Error(
        `unknown preset "${config.preset}" for ${this.provider}/${config.model} (try: ${Object.keys(this.#presets).join(", ")})`,
      );
    }
  }

  /** Applies the configured preset to the built chat request. */
  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    applyChatPreset(
      params as unknown as RequestParams,
      this.#presets[request.modelConfig.preset ?? ""],
    );
    return params;
  }
}
