import type {
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelProvider,
  ModelRequest,
} from "@harness/protocol";
import {
  OpenAIResponsesProvider,
  OpenAIChatProvider,
  type OpenAICredentials,
} from "@harness/openai-core";
import {
  AnthropicProvider,
  type AnthropicCredentials,
  type AnthropicRequestConfig,
} from "@harness/anthropic-core";
import { familyOf, listModels, maxOutputOf } from "./roster.ts";

/**
 * Responses-family subclass for the Go gateway: same wire shape as the OpenAI
 * Responses provider, retaining encrypted reasoning for stateless continuation
 * and applying a gateway-specific reasoning default.
 */
class GoResponsesProvider extends OpenAIResponsesProvider {
  constructor(credentials: OpenAICredentials, provider: string) {
    super({
      provider,
      credentials,
      reasoning: { effort: "medium", summary: "auto" },
      supportsMaxOutputTokens: true,
    });
  }
}

/**
 * Messages-family subclass for the Go gateway: overrides the per-request config so
 * `max_tokens` comes from the opencode-go roster (the stock Anthropic provider
 * falls back to a hardcoded 8192 for uncataloged models, which would silently
 * truncate MiniMax/Qwen generation). No thinking/effort for Go's models.
 */
class GoMessagesProvider extends AnthropicProvider {
  constructor(credentials: AnthropicCredentials, provider: string) {
    super({ provider, credentials });
  }

  protected override buildConfig(request: ModelRequest): AnthropicRequestConfig {
    return { maxTokens: maxOutputOf(request.modelConfig.model) ?? 8192 };
  }
}

export interface OpenCodeGoProviderOptions {
  openai: OpenAICredentials;
  anthropic: AnthropicCredentials;
  /** Registry name; defaults to `"opencode-go"`. */
  provider?: string;
}

/**
 * A `ModelProvider` for the OpenCode Go gateway: one registry id, one key, three
 * transports. Each rostered model streams on its compiled family's transport.
 */
export class OpenCodeGoProvider implements ModelProvider {
  readonly provider: string;
  readonly #chat: OpenAIChatProvider;
  readonly #responses: GoResponsesProvider;
  readonly #messages: GoMessagesProvider;

  constructor(opts: OpenCodeGoProviderOptions) {
    this.provider = opts.provider ?? "opencode-go";
    this.#chat = new OpenAIChatProvider({ provider: this.provider, credentials: opts.openai });
    this.#responses = new GoResponsesProvider(opts.openai, this.provider);
    this.#messages = new GoMessagesProvider(opts.anthropic, this.provider);
  }

  capabilities(model: string): ModelCapabilities {
    switch (familyOf(model)) {
      case "responses":
        return { contentTypes: ["text"], toolCalling: true, fileTools: "apply_patch" };
      case "messages":
        return { contentTypes: ["text"], toolCalling: true, fileTools: "text_editor" };
      case "chat":
        // Function-only: the chat transport cannot carry freeform custom tools.
        return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" };
      case undefined:
        throw new Error(`unknown model "${model}" for provider ${this.provider}`);
    }
  }

  validateConfig(config: ModelConfig): void {
    if (!familyOf(config.model)) {
      throw new Error(`unknown model "${config.model}" for provider ${this.provider}`);
    }
    // No preset axis on this subscription provider in v1; reject rather than ignore.
    if (config.preset) {
      throw new Error(
        `opencode-go has no presets; preset "${config.preset}" is not supported (try removing it)`,
      );
    }
  }

  listModels(): ModelInfo[] {
    return listModels(this.provider);
  }

  async *stream(request: ModelRequest, signal: AbortSignal) {
    switch (familyOf(request.modelConfig.model)) {
      case "responses":
        yield* this.#responses.stream(request, signal);
        break;
      case "messages":
        yield* this.#messages.stream(request, signal);
        break;
      case "chat":
        yield* this.#chat.stream(request, signal);
        break;
      case undefined:
        throw new Error(
          `unknown model "${request.modelConfig.model}" for provider ${this.provider}`,
        );
    }
  }
}
