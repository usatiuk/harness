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
import { familyOf, listModels, maxOutputOf, modelSpec, presetFor } from "./roster.ts";

/** Effort control selected for a Chat or Responses request. */
function effortFor(request: ModelRequest): string | undefined {
  const preset = presetFor(request.modelConfig.model, request.modelConfig.preset);
  if (!preset) return undefined;
  if (preset.control.kind !== "effort") {
    throw new Error(
      `preset "${preset.value}" for ${request.modelConfig.model} is not an effort control`,
    );
  }
  return preset.control.effort;
}

/** Chat-family subclass that maps the rostered preset to the compatible wire field. */
class GoChatProvider extends OpenAIChatProvider {
  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    const effort = effortFor(request);
    if (effort) {
      // The pinned SDK predates the gateway's `max` value but serializes it unchanged.
      (params as unknown as Record<string, unknown>).reasoning_effort = effort;
    }
    return params;
  }
}

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
      reasoning: { summary: "auto" },
      supportsMaxOutputTokens: true,
    });
  }

  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    const effort = effortFor(request);
    if (effort) {
      (params as unknown as Record<string, unknown>).reasoning = {
        ...params.reasoning,
        // The pinned SDK predates GPT-5.6's `max` value but sends it unchanged.
        effort,
      };
    }
    return params;
  }
}

/**
 * Messages-family subclass for the Go gateway: overrides the per-request config so
 * `max_tokens` comes from the opencode-go roster (the stock Anthropic provider
 * falls back to a hardcoded 8192 for uncataloged models, which would silently
 * truncate MiniMax/Qwen generation). Model-scoped presets additionally select
 * MiniMax's thinking toggle or Qwen's compiled thinking budget.
 */
class GoMessagesProvider extends AnthropicProvider {
  constructor(credentials: AnthropicCredentials, provider: string) {
    super({ provider, credentials });
  }

  protected override buildConfig(request: ModelRequest): AnthropicRequestConfig {
    const config: AnthropicRequestConfig = {
      maxTokens: maxOutputOf(request.modelConfig.model) ?? 8192,
    };
    const preset = presetFor(request.modelConfig.model, request.modelConfig.preset);
    if (!preset) return config;
    switch (preset.control.kind) {
      case "thinking":
        config.thinking = { type: preset.control.thinking };
        break;
      case "thinking-budget": {
        // Messages requires the thinking budget to stay below the effective output cap. An
        // invocation-specific cap is more specific than the compiled preset budget.
        const outputCap = request.maxOutputTokens ?? config.maxTokens;
        const budgetTokens = Math.min(preset.control.budgetTokens, outputCap - 1);
        if (budgetTokens < 1024) {
          throw new Error(
            `preset "${preset.value}" for ${request.modelConfig.model} requires an output cap above 1024 tokens`,
          );
        }
        config.thinking = { type: "enabled", budget_tokens: budgetTokens };
        break;
      }
      case "effort":
        throw new Error(
          `preset "${preset.value}" for ${request.modelConfig.model} is not a thinking control`,
        );
    }
    return config;
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
    this.#chat = new GoChatProvider({ provider: this.provider, credentials: opts.openai });
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
    const spec = modelSpec(config.model);
    if (!spec) {
      throw new Error(`unknown model "${config.model}" for provider ${this.provider}`);
    }
    if (config.preset && !spec.presets?.some((preset) => preset.value === config.preset)) {
      const offered = spec.presets?.map((preset) => preset.value).join(", ");
      throw new Error(
        offered
          ? `unknown preset "${config.preset}" for ${this.provider}/${config.model} (try: ${offered})`
          : `${this.provider}/${config.model} has no presets; preset "${config.preset}" is not supported`,
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
