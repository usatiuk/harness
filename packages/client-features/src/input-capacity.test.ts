import { expect, it } from "vitest";
import { zeroUsage, type ModelInfo } from "@harness/protocol";
import { inputCapacity } from "./input-capacity.ts";
import type { State } from "./transcript-reducer.ts";

const checkpoint: NonNullable<State["agentContext"]> = {
  provider: "agent",
  model: "exact",
  turnId: "turn" as import("@harness/protocol").TurnId,
  createdAt: 0,
  usage: { ...zeroUsage(), inputTokens: 100 },
};
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
    expect(inputCapacity(checkpoint, [model(limits)])).toMatchObject({
      used: 100,
      limit,
      basis,
      percent,
    });
  },
);
it("distinguishes zero input, missing usage, absent checkpoint and exact model identity", () => {
  const models = [model({ maxInputTokens: 1000 })];
  expect(inputCapacity({ ...checkpoint, usage: zeroUsage() }, models).percent).toBe(0);
  expect(inputCapacity({ ...checkpoint, usage: null }, models)).toMatchObject({
    used: undefined,
    percent: undefined,
    limit: 1000,
  });
  expect(inputCapacity(undefined, models)).toMatchObject({
    used: undefined,
    limit: undefined,
    percent: undefined,
  });
  expect(inputCapacity({ ...checkpoint, model: "other" }, models)).toMatchObject({
    used: 100,
    limit: undefined,
  });
  expect(inputCapacity(checkpoint, [{ ...models[0]!, provider: "other" }]).limit).toBeUndefined();
});
