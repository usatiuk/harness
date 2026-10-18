import { describe, expect, it } from "vitest";
import { modelId, selectionId, customToolInputSchema, mergeModelMetadata } from "./model.ts";

describe("selectionId", () => {
  it("is provider/model when no preset is set", () => {
    const m = { provider: "openai", model: "gpt-5.1" };
    expect(selectionId(m)).toBe("openai/gpt-5.1");
    expect(modelId(m)).toBe("openai/gpt-5.1");
  });

  it("appends the preset when set", () => {
    expect(selectionId({ provider: "openai", model: "gpt-5.1", preset: "high" })).toBe(
      "openai/gpt-5.1/high",
    );
  });
});

it("rejects grammar support without custom input", () => {
  expect(customToolInputSchema.safeParse({ supported: false, grammars: ["lark"] }).success).toBe(
    false,
  );
});
it("merges explicit model additions and partial overrides without inventing limits", () => {
  expect(
    mergeModelMetadata("fixture", [{ provider: "fixture", model: "known", contextWindow: 4096 }], {
      known: { label: "Override", supportsImages: false },
      added: { preferredEditTool: "patch" },
    }),
  ).toEqual([
    {
      provider: "fixture",
      model: "known",
      contextWindow: 4096,
      label: "Override",
      supportsImages: false,
    },
    { provider: "fixture", model: "added", preferredEditTool: "patch" },
  ]);
  expect(() =>
    mergeModelMetadata("fixture", [{ provider: "fixture", model: "known", contextWindow: 4096 }], {
      known: { maxOutputTokens: 8192 },
    }),
  ).toThrow("maxOutputTokens cannot exceed contextWindow");
});
