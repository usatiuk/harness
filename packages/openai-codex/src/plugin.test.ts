import { describe, expect, it } from "vitest";
import type { CodexAuth } from "./auth.ts";
import { CODEX_PROVIDER, codexPlugin } from "./plugin.ts";

describe("codexPlugin", () => {
  it("uses the Codex limits for gpt-5.5", () => {
    const provider = codexPlugin({} as CodexAuth).providers?.()[0];
    const gpt = provider?.listModels().find((model) => model.model === "gpt-5.5");

    expect(provider?.provider).toBe(CODEX_PROVIDER);
    expect(gpt?.contextWindow).toBe(400_000);
    expect(gpt?.maxOutputTokens).toBe(128_000);
  });
});
