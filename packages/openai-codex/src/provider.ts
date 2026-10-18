import {
  OPENAI_MODELS,
  OpenAIResponsesProvider,
  type OpenAIModelSpec,
  type OpenAIModelConfig,
} from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

// Public Codex roster, image/patch support and efforts verified 2026-10-18; capacity assumptions below.
// Ultra is Codex orchestration, not an effort supported by a Harness model invocation.
const CODEX_MODELS = OPENAI_MODELS.filter(
  (model) => model.model.startsWith("gpt-6") || model.model.startsWith("gpt-5.6"),
).map((model): OpenAIModelSpec => ({
  model: model.model,
  customToolInput: { supported: true, grammars: ["lark"] },
  preferredEditTool: "patch",
  ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  // Operational ceilings inferred from Codex's working budgets plus the output reserve.
  // These are assumptions, not verified backend limits; combined context remains unknown.
  maxInputTokens: model.model === "gpt-6.1-sol" ? 628_000 : 400_000,
  ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  presets: model.presets.filter((entry) => entry.value !== "none"),
  defaultPreset: model.model === "gpt-6.1-sol" || model.model === "gpt-5.6-sol" ? "low" : "medium",
}));

/** A subscription connection with Codex-specific capacity and request policy. */
export function createCodexProvider(
  auth: CodexAuth,
  provider: string,
  webSearch = false,
  modelOverrides: Record<string, OpenAIModelConfig> = {},
): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    provider,
    webSearch,
    credentials: codexCredentials(auth),
    models: CODEX_MODELS,
    modelOverrides,
    supportsMaxOutputTokens: false,
  });
}
