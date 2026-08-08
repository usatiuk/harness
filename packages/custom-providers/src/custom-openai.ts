import { OpenAIResponsesProvider } from "@harness/openai-core";
import { apiKeyCredentials } from "@harness/openai-api";
import type {
  ContentBlock,
  FileToolsProfile,
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelRequest,
} from "@harness/protocol";
import type { OpenAIPreset } from "@harness/config";

/** Loose view of the SDK request so presets can touch freeform extra fields. */
type RequestParams = Record<string, unknown>;

/** Merges one configured preset's sampling knobs onto the built Responses request. */
function applyOpenAIPreset(params: RequestParams, preset?: OpenAIPreset): void {
  if (!preset) return;
  if (preset.temperature !== undefined) params.temperature = preset.temperature;
  if (preset.topP !== undefined) params.top_p = preset.topP;
  if (preset.maxTokens !== undefined) params.max_output_tokens = preset.maxTokens;
  if (preset.frequencyPenalty !== undefined) params.frequency_penalty = preset.frequencyPenalty;
  if (preset.presencePenalty !== undefined) params.presence_penalty = preset.presencePenalty;
  Object.assign(params, preset.extraBody);
}

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
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  presets?: Record<string, OpenAIPreset>;
  /** File-editing dialect; defaults to `string_replace` (function-only tools, safe for all OpenAI endpoints). */
  fileTools?: FileToolsProfile;
  /**
   * Backends that silently drop Responses `instructions` (e.g. OVMS) get the system context as a
   * leading `system` input message instead. Off by default; only backends known to ignore the field
   * should opt in.
   */
  sendInstructionsAsSystem?: boolean;
}

/** An OpenAI Responses-compatible provider defined by settings rather than a compiled catalog. */
export class CustomOpenAIProvider extends OpenAIResponsesProvider {
  readonly #model: string;
  readonly #contextWindow: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #presets: Record<string, OpenAIPreset>;
  readonly #fileTools: FileToolsProfile;
  readonly #sendInstructionsAsSystem: boolean;

  constructor(opts: CustomOpenAIProviderOptions) {
    super({
      provider: opts.id,
      credentials: apiKeyCredentials({ apiKey: opts.apiKey, baseURL: opts.endpoint }),
    });
    this.#model = opts.model;
    this.#contextWindow = opts.contextWindow;
    this.#maxOutputTokens = opts.maxOutputTokens;
    this.#presets = opts.presets ?? {};
    this.#fileTools = opts.fileTools ?? "string_replace";
    this.#sendInstructionsAsSystem = opts.sendInstructionsAsSystem ?? false;
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
      this.#presets[request.modelConfig.preset ?? ""],
    );
    return params;
  }
}
