import { describe, expect, it } from "vitest";
import { usageSchema, type ModelPricing, type Usage } from "./model.ts";
import { addUsage, costOf, zeroUsage } from "./usage.ts";

describe("addUsage", () => {
  it("sums pointwise and starts from zero", () => {
    const a: Usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 50 };
    expect(addUsage(zeroUsage(), a)).toEqual(a);
    expect(addUsage(a, a)).toEqual({ inputTokens: 200, outputTokens: 20, cachedReadTokens: 100 });
  });

  it("merges TTL maps key-by-key", () => {
    const a: Usage = {
      inputTokens: 100,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: { 300: 40, 3600: 10 },
    };
    const b: Usage = {
      inputTokens: 50,
      outputTokens: 5,
      cachedReadTokens: 20,
      cacheWriteTokens: { 300: 60 },
    };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 150,
      outputTokens: 5,
      cachedReadTokens: 20,
      cacheWriteTokens: { 300: 100, 3600: 10 },
    });
  });

  it("omits the TTL map when neither side has one", () => {
    expect(addUsage(zeroUsage(), zeroUsage())).not.toHaveProperty("cacheWriteTokens");
  });
});

describe("costOf", () => {
  it("prices an OpenAI-shaped request (cached reads discounted, no write billing)", () => {
    const pricing: ModelPricing = { input: 1.25, output: 10, cachedRead: 0.125 };
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedReadTokens: 400_000,
    };
    // 600K uncached × $1.25 + 400K cached × $0.125 + 100K out × $10, per MTok
    expect(costOf(usage, pricing)).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125 + 0.1 * 10, 10);
  });

  it("prices Anthropic-shaped cache writes by TTL", () => {
    const pricing: ModelPricing = {
      input: 3,
      output: 15,
      cachedRead: 0.3,
      cacheWrite: { 300: 3.75, 3600: 6 },
    };
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedReadTokens: 500_000,
      cacheWriteTokens: { 300: 200_000, 3600: 100_000 },
    };
    // 200K uncached × $3 + 500K read × $0.3 + 200K @300s × $3.75 + 100K @3600s × $6
    expect(costOf(usage, pricing)).toBeCloseTo(0.2 * 3 + 0.5 * 0.3 + 0.2 * 3.75 + 0.1 * 6, 10);
  });

  it("bills the whole request on the long-context card past the threshold", () => {
    const pricing: ModelPricing = {
      input: 5,
      output: 30,
      cachedRead: 0.5,
      longContext: { threshold: 272_000, input: 10, output: 45, cachedRead: 1 },
    };
    const at = (inputTokens: number): Usage => ({
      inputTokens,
      outputTokens: 100_000,
      cachedReadTokens: 100_000,
    });
    // At the threshold: base card. One token past: everything reprices, cached reads included.
    expect(costOf(at(272_000), pricing)).toBeCloseTo(0.172 * 5 + 0.1 * 0.5 + 0.1 * 30, 10);
    expect(costOf(at(272_001), pricing)).toBeCloseTo(0.172001 * 10 + 0.1 * 1 + 0.1 * 45, 10);
  });

  it("falls back to the input rate for cached reads and unlisted write TTLs", () => {
    const pricing: ModelPricing = { input: 2, output: 8 };
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedReadTokens: 300_000,
      cacheWriteTokens: { 600: 100_000 },
    };
    // Everything bills at the input rate → exactly inputTokens × $2 / MTok
    expect(costOf(usage, pricing)).toBeCloseTo(2, 10);
  });
});

describe("usageSchema", () => {
  it("round-trips JSON, coercing TTL keys back to numbers", () => {
    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 2,
      cachedReadTokens: 4,
      cacheWriteTokens: { 300: 3 },
    };
    expect(usageSchema.parse(JSON.parse(JSON.stringify(usage)))).toEqual(usage);
  });

  it("rejects missing cachedReadTokens and negative counts", () => {
    expect(() => usageSchema.parse({ inputTokens: 1, outputTokens: 1 })).toThrow();
    expect(() =>
      usageSchema.parse({ inputTokens: -1, outputTokens: 0, cachedReadTokens: 0 }),
    ).toThrow();
  });
});
