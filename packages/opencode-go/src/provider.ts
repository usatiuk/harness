import type {
  ModelCapabilities,
  ModelConfig,
  ModelInfo,
  ModelProvider,
  ModelRequest,
} from "@harness/protocol";
import {
  OpenAIResponsesTransport,
  buildResponseParams,
  OpenAIChatTransport,
  type OpenAICredentials,
} from "@harness/openai-core";
import {
  AnthropicMessagesTransport,
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
class GoChatProvider extends OpenAIChatTransport {
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
class GoResponsesProvider extends OpenAIResponsesTransport {
  constructor(credentials: OpenAICredentials, provider: string) {
    super({
      provider,
      credentials,
    });
  }

  protected override buildParams(request: ModelRequest) {
    const effort = effortFor(request);
    const reasoning = { summary: "auto", ...(effort ? { effort } : {}) } as Parameters<
      typeof buildResponseParams
    >[1];
    return buildResponseParams(request, reasoning, this.provider, true);
  }
}

/** Messages policy from the Go roster, including model-scoped thinking controls. */
class GoMessagesProvider extends AnthropicMessagesTransport {
  constructor(credentials: AnthropicCredentials, provider: string) {
    super({ provider, credentials });
  }

  protected override buildConfig(request: ModelRequest): AnthropicRequestConfig {
    const config: AnthropicRequestConfig = {
      maxTokens: request.maxOutputTokens ?? maxOutputOf(request.modelConfig.model) ?? 8192,
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
        const budgetTokens = Math.min(preset.control.budgetTokens, config.maxTokens - 1);
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
  readonly #chat: OpenAIChatTransport;
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
