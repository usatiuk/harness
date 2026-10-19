import { describe, expect, it } from "vitest";
import {
  modelId,
  selectionId,
  customToolInputSchema,
  mergeModelMetadata,
  TransientModelFailure,
  parseRetryAfterMs,
} from "./model.ts";

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

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds as a wait in milliseconds", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2000);
    expect(parseRetryAfterMs("0", 0)).toBe(0);
    expect(parseRetryAfterMs(" 1.5 ", 0)).toBe(1500);
  });

  it("reads an HTTP-date relative to now and clamps past dates to zero", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseRetryAfterMs("Sun, 18 Oct 2026 12:00:30 GMT", now)).toBe(30000);
    expect(parseRetryAfterMs("Sun, 18 Oct 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("yields undefined for missing or unparseable values instead of guessing", () => {
    expect(parseRetryAfterMs(undefined, 0)).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
    expect(parseRetryAfterMs("", 0)).toBeUndefined();
    expect(parseRetryAfterMs("soon", 0)).toBeUndefined();
    expect(parseRetryAfterMs("-3", 0)).toBeUndefined();
    // V8's lenient Date.parse turns some non-dates into dates ("-3" is a year);
    // only RFC 7231 date shapes are accepted.
    expect(parseRetryAfterMs("1e3", 0)).toBeUndefined();
    expect(parseRetryAfterMs("Infinity", 0)).toBeUndefined();
    expect(parseRetryAfterMs("2024-10-18", 0)).toBeUndefined();
  });
});

describe("TransientModelFailure", () => {
  it("carries its reason and provider-requested wait", () => {
    const failure = new TransientModelFailure("rate_limit", { retryAfterMs: 1500 });
    expect(failure.reason).toBe("rate_limit");
    expect(failure.retryAfterMs).toBe(1500);
    expect(failure.name).toBe("TransientModelFailure");
  });

  it("defaults its message to the classification", () => {
    expect(new TransientModelFailure("overloaded").message).toBe(
      "transient model failure: overloaded",
    );
  });
});
