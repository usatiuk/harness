import {
  OPENAI_MODELS,
  OpenAIResponsesProvider,
  type OpenAIModelSpec,
  type OpenAIModelConfig,
} from "@harness/openai-core";
import type { ModelCallContext } from "@harness/protocol";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

// Public GPT-6/5.6 metadata from the Codex CLI 0.171.0 built-in catalog.
// Ultra is Codex orchestration, not an effort supported by a Harness model invocation.
const extendedWindow = new Set(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra"]);
const lowDefault = new Set([...extendedWindow, "gpt-6.2-astra", "gpt-6-astra", "gpt-5.6-sol"]);
const CODEX_MODELS = OPENAI_MODELS.filter(
  (model) => model.model.startsWith("gpt-6") || model.model.startsWith("gpt-5.6"),
).map((model): OpenAIModelSpec => ({
  model: model.model,
  customToolInput: { supported: true, grammars: ["lark"] },
  preferredEditTool: "patch",
  ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  // Operational ceilings inferred from Codex's working budgets plus the output reserve.
  // These are assumptions, not verified backend limits; combined context remains unknown.
  maxInputTokens: extendedWindow.has(model.model) ? 628_000 : 400_000,
  ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  presets: model.presets.filter((entry) => entry.value !== "none"),
  defaultPreset: lowDefault.has(model.model) ? "low" : "medium",
}));

class CodexResponsesProvider extends OpenAIResponsesProvider {
  protected override requestRouting({
    conversationId,
    rootConversationId = conversationId,
  }: ModelCallContext) {
    return {
      cacheKey: rootConversationId,
      headers: { "session-id": rootConversationId, "thread-id": conversationId },
    };
  }
}

/** A subscription connection with Codex-specific capacity and request policy. */
export function createCodexProvider(
  auth: CodexAuth,
  provider: string,
  webSearch = false,
  modelOverrides: Record<string, OpenAIModelConfig> = {},
): OpenAIResponsesProvider {
  return new CodexResponsesProvider({
    provider,
    webSearch,
    credentials: codexCredentials(auth),
    models: CODEX_MODELS,
    modelOverrides,
    supportsMaxOutputTokens: false,
  });
}
