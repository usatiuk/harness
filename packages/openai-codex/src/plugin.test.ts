import { describe, expect, it } from "vitest";
import type { CodexAuth } from "./auth.ts";
import { CODEX_PROVIDER, codexPlugin } from "./plugin.ts";

describe("codexPlugin", () => {
  it("exposes the current ChatGPT roster with Codex capacity and effort controls", () => {
    const provider = codexPlugin({} as CodexAuth).providers?.()[0];
    const gpt = provider?.listModels().find((model) => model.model === "gpt-5.5");

    expect(provider?.provider).toBe(CODEX_PROVIDER);
    expect(gpt?.contextWindow).toBe(272_000);
    expect(gpt?.maxOutputTokens).toBe(128_000);
    const models = provider!.listModels();
    expect(models.map((entry) => entry.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(models.find((entry) => entry.model === "gpt-6.1-sol")?.defaultPreset).toBe("low");
    for (const model of models) {
      expect(model.contextWindow).toBe(272_000);
      expect(model.presets?.map((entry) => entry.value)).not.toContain("none");
      expect(model.presets?.map((entry) => entry.value)).not.toContain("ultra");
    }
  });
});
