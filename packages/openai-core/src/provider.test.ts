import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAIResponsesProvider, reasoningForSelection } from "./provider.ts";

const BASE: OpenAI.Reasoning = { effort: "medium", summary: "auto" };

describe("reasoningForSelection", () => {
  it("uses the chosen effort when the model offers it, keeping other base fields", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1", effort: "high" }, BASE);
    expect(r).toEqual({ effort: "high", summary: "auto" });
  });

  it("falls back to the model default when effort is absent", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1" }, BASE);
    expect(r.effort).toBe("medium");
  });

  it("falls back to the model default when effort is not offered", () => {
    // codex does not offer `none`
    const r = reasoningForSelection(
      { provider: "openai", model: "gpt-5.1-codex", effort: "none" },
      BASE,
    );
    expect(r.effort).toBe("medium");
  });

  it("leaves base untouched for an unknown model", () => {
    const r = reasoningForSelection({ provider: "openai", model: "mystery", effort: "high" }, BASE);
    expect(r).toBe(BASE);
  });
});

describe("listModels", () => {
  it("declares per-model efforts and a default", () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: async () => ({}) as never },
    });
    const models = provider.listModels();
    const gpt = models.find((m) => m.model === "gpt-5.1");
    expect(gpt?.defaultEffort).toBe("medium");
    expect(gpt?.efforts?.map((e) => e.value)).toEqual(["none", "low", "medium", "high"]);
  });
});
