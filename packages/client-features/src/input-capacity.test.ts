import { expect, it } from "vitest";
import { type ModelInfo } from "@harness/protocol";
import { inputCapacity } from "./input-capacity.ts";
const model = (limits: Partial<ModelInfo>): ModelInfo => ({
  provider: "agent",
  model: "exact",
  ...limits,
});
it.each([
  [{ maxInputTokens: 1000 }, 1000, "input limit", 10],
  [{ contextWindow: 2000 }, 2000, "shared context window", 5],
  [{ maxInputTokens: 1000, contextWindow: 2000 }, 1000, "input limit", 10],
  [{ maxOutputTokens: 500 }, undefined, undefined, undefined],
  [{}, undefined, undefined, undefined],
] as const)(
  "presents independent limits %j without manufacturing capacity",
  (limits, limit, basis, percent) => {
    expect(inputCapacity(model(limits), 100)).toMatchObject({
      used: 100,
      limit,
      basis,
      percent,
    });
  },
);
it("distinguishes zero usage, unknown usage, and unknown capacity", () => {
  const known = model({ maxInputTokens: 1000 });
  expect(inputCapacity(known, 0).percent).toBe(0);
  expect(inputCapacity(known, undefined)).toMatchObject({ limit: 1000, percent: undefined });
  expect(inputCapacity(undefined, 100)).toMatchObject({ used: 100, percent: undefined });
});
