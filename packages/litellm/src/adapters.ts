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
import type { ModelProvider, ModelRequest } from "@harness/protocol";
import type { Generation, ModelProfile, Transport } from "./config.ts";

function generation(profile: ModelProfile, request: ModelRequest): Generation {
  const preset = request.modelConfig.preset ?? profile.defaultPreset;
  return { ...profile, ...(preset ? profile.presets?.[preset] : {}) };
}

function outputCap(
  profile: ModelProfile,
  controls: Generation,
  request: ModelRequest,
): number | undefined {
  const cap = request.maxOutputTokens ?? controls.requestMaxOutputTokens;
  return cap === undefined
    ? undefined
    : Math.min(cap, profile.maxOutputTokens ?? cap, profile.contextWindow ?? cap);
}

class GatewayResponses extends OpenAIResponsesTransport {
  constructor(
    credentials: OpenAICredentials,
    provider: string,
    readonly profile: ModelProfile,
  ) {
    super({ credentials, provider });
  }
  protected override buildParams(request: ModelRequest) {
    const controls = generation(this.profile, request);
    // The gateway can accept effort values newer than the pinned SDK's union.
    const reasoning =
      controls.reasoningEffort || this.profile.reasoningSummary
        ? ({
            ...(controls.reasoningEffort ? { effort: controls.reasoningEffort } : {}),
            ...(this.profile.reasoningSummary ? { summary: this.profile.reasoningSummary } : {}),
          } as Parameters<typeof buildResponseParams>[1])
        : undefined;
    const includeEncryptedReasoning =
      reasoning !== undefined ||
      request.items.some(
        ({ payload }) =>
          payload?.provider === this.provider &&
          payload.model === request.modelConfig.model &&
          payload.type === "reasoning",
      );
    const params = buildResponseParams(
      request,
      reasoning,
      this.provider,
      includeEncryptedReasoning,
    );
    if (controls.temperature !== undefined) params.temperature = controls.temperature;
    if (controls.topP !== undefined) params.top_p = controls.topP;
    const cap = outputCap(this.profile, controls, request);
    if (cap !== undefined) params.max_output_tokens = cap;
    return params;
  }
}

class GatewayChat extends OpenAIChatTransport {
  constructor(
    credentials: OpenAICredentials,
    provider: string,
    readonly profile: ModelProfile,
  ) {
    super({ credentials, provider });
  }
  protected override buildParams(request: ModelRequest) {
    const params = super.buildParams(request);
    const controls = generation(this.profile, request);
    if (controls.reasoningEffort)
      (params as unknown as Record<string, unknown>).reasoning_effort = controls.reasoningEffort;
    if (controls.temperature !== undefined) params.temperature = controls.temperature;
    if (controls.topP !== undefined) params.top_p = controls.topP;
    const cap = outputCap(this.profile, controls, request);
    if (cap !== undefined) params.max_tokens = cap;
    return params;
  }
}

class GatewayMessages extends AnthropicMessagesTransport {
  constructor(
    credentials: AnthropicCredentials,
    provider: string,
    readonly profile: ModelProfile,
  ) {
    super({ credentials, provider });
  }
  protected override buildConfig(request: ModelRequest): AnthropicRequestConfig {
    const controls = generation(this.profile, request);
    const maxTokens =
      outputCap(this.profile, controls, request) ??
      Math.min(8192, this.profile.maxOutputTokens ?? 8192, this.profile.contextWindow ?? 8192);
    const config: AnthropicRequestConfig = { maxTokens };
    if (controls.temperature !== undefined) config.temperature = controls.temperature;
    if (controls.topP !== undefined) config.topP = controls.topP;
    if (controls.reasoningEffort)
      config.effort = controls.reasoningEffort as AnthropicRequestConfig["effort"] & string;
    if (controls.thinking) {
      if (controls.thinking.type === "enabled" && controls.thinking.budget_tokens >= maxTokens)
        throw new Error("Invocation output cap must exceed the configured thinking budget");
      config.thinking =
        controls.thinking.type === "adaptive"
          ? {
              type: "adaptive",
              ...(controls.thinking.display ? { display: controls.thinking.display } : {}),
            }
          : controls.thinking;
    }
    return config;
  }
}

export function gatewayAdapter(
  transport: Transport,
  profile: ModelProfile,
  provider: string,
  openai: OpenAICredentials,
  anthropic: AnthropicCredentials,
): Pick<ModelProvider, "stream"> {
  switch (transport) {
    case "openai-responses":
      return new GatewayResponses(openai, provider, profile);
    case "openai-completions":
      return new GatewayChat(openai, provider, profile);
    case "anthropic-messages":
      return new GatewayMessages(anthropic, provider, profile);
  }
}
