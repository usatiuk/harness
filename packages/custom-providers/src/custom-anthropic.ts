import { AnthropicProvider, type AnthropicRequestConfig } from "@harness/anthropic-core";
import { apiKeyCredentials } from "@harness/anthropic-api";
import type {
  FileToolsProfile,
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelRequest,
} from "@harness/protocol";
import type { AnthropicPreset } from "@harness/config";

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
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  presets?: Record<string, AnthropicPreset>;
  /** File-editing dialect; defaults to `text_editor` (the Messages API's native editor profile). */
  fileTools?: FileToolsProfile;
}

/** An Anthropic Messages-compatible provider defined by settings rather than a compiled catalog. */
export class CustomAnthropicProvider extends AnthropicProvider {
  readonly #model: string;
  readonly #contextWindow: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #presets: Record<string, AnthropicPreset>;
  readonly #fileTools: FileToolsProfile;

  constructor(opts: CustomAnthropicProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#model = opts.model;
    this.#contextWindow = opts.contextWindow;
    this.#maxOutputTokens = opts.maxOutputTokens;
    this.#presets = opts.presets ?? {};
    this.#fileTools = opts.fileTools ?? "text_editor";
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

  /**
   * Drops thinking/effort knobs (local backends reject them) and applies the configured preset.
   * The built-in base falls back to a hardcoded `MAX_TOKENS_FALLBACK` when the model isn't in its
   * catalog; fix that by defaulting from the configured cap so the wire cap matches the advertised
   * `ModelInfo.maxOutputTokens` (otherwise generation is silently truncated). Preset wins above all.
   */
  protected override buildConfig(request: ModelRequest) {
    const config = super.buildConfig(request);
    delete config.thinking;
    delete config.effort;
    if (this.#maxOutputTokens !== undefined) {
      config.maxTokens = this.#maxOutputTokens;
    }
    applyAnthropicPreset(config, this.#presets[request.modelConfig.preset ?? ""]);
    return config;
  }
}
