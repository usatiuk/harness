import type { Plugin } from "@harness/protocol";
import { OPENAI_MODELS, OpenAIResponsesProvider } from "@harness/openai-core";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";

export const CODEX_PROVIDER = "openai-codex";

// ChatGPT's published roster and the local Codex model metadata, verified 2026-10-03.
// Ultra is Codex orchestration, not an effort supported by a Harness model invocation.
const CODEX_MODELS = OPENAI_MODELS.filter(
  (model) =>
    model.model.startsWith("gpt-6") ||
    model.model.startsWith("gpt-5.6") ||
    model.model === "gpt-5.5",
).map((model) => ({
  ...model,
  contextWindow: 272_000,
  presets: model.presets.filter((entry) => entry.value !== "none"),
  defaultPreset: model.model === "gpt-6.1-sol" || model.model === "gpt-5.6-sol" ? "low" : "medium",
}));

/** Registers the Codex (ChatGPT subscription) Responses provider, authenticated via OAuth. */
export function codexPlugin(auth: CodexAuth, provider = CODEX_PROVIDER): Plugin {
  return {
    id: provider,
    providers: () => [
      new OpenAIResponsesProvider({
        provider,
        credentials: codexCredentials(auth),
        models: CODEX_MODELS,
        supportsMaxOutputTokens: false,
      }),
    ],
  };
}
