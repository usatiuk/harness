import { describe, expect, it } from "vitest";
import { modelId, selectionId } from "./model.ts";

describe("selectionId", () => {
  it("is provider/model when no effort is set", () => {
    const m = { provider: "openai", model: "gpt-5.1" };
    expect(selectionId(m)).toBe("openai/gpt-5.1");
    expect(modelId(m)).toBe("openai/gpt-5.1");
  });

  it("appends the effort when set", () => {
    expect(selectionId({ provider: "openai", model: "gpt-5.1", effort: "high" })).toBe(
      "openai/gpt-5.1/high",
    );
  });
});
