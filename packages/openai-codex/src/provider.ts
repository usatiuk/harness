import { OPENAI_MODELS, OpenAIResponsesProvider } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

// ChatGPT roster and Codex effort controls verified 2026-10-03; capacity assumptions below.
// Ultra is Codex orchestration, not an effort supported by a Harness model invocation.
const CODEX_MODELS = OPENAI_MODELS.filter(
  (model) =>
    model.model.startsWith("gpt-6") ||
    model.model.startsWith("gpt-5.6") ||
    model.model === "gpt-5.5",
).map((model) => ({
  model: model.model,
  ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  // Operational ceilings inferred from Codex's working budgets plus the output reserve.
  // These are assumptions, not verified backend limits; combined context remains unknown.
  maxInputTokens: model.model === "gpt-6.1-sol" ? 628_000 : 400_000,
  maxOutputTokens: model.maxOutputTokens,
  pricing: model.pricing,
  presets: model.presets.filter((entry) => entry.value !== "none"),
  defaultPreset: model.model === "gpt-6.1-sol" || model.model === "gpt-5.6-sol" ? "low" : "medium",
}));

/** A subscription connection with Codex-specific capacity and request policy. */
export function createCodexProvider(
  auth: CodexAuth,
  provider: string,
  webSearch = false,
): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    provider,
    webSearch,
    credentials: codexCredentials(auth),
    models: CODEX_MODELS,
    supportsMaxOutputTokens: false,
  });
}
