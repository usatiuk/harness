import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelInfo, ModelProvider, ModelStreamEvent, Tool } from "@harness/protocol";
import { ProviderRegistry, ToolSet } from "./registry.ts";

const provider = (name: string, models: ModelInfo[] = []): ModelProvider => ({
  provider: name,
  capabilities: () => ({ contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" }),
  validateConfig: () => {},
  stream: async function* (): AsyncIterable<ModelStreamEvent> {},
  listModels: () => models,
});

describe("ProviderRegistry.listModels", () => {
  it("aggregates catalogs in registration order, skipping empty ones", () => {
    const reg = new ProviderRegistry();
    reg.register(provider("a", [{ provider: "a", model: "a1" }]));
    reg.register(provider("b")); // empty catalog → contributes nothing
    reg.register(
      provider("c", [
        { provider: "c", model: "c1" },
        { provider: "c", model: "c2" },
      ]),
    );
    expect(reg.listModels()).toEqual([
      { provider: "a", model: "a1" },
      { provider: "c", model: "c1" },
      { provider: "c", model: "c2" },
    ]);
  });
});

const tool = (name: string): Tool => ({
  name,
  description: name,
  input: { kind: "function", schema: z.strictObject({}) },
  execute: () => Promise.resolve({ forModel: [], status: "ok" }),
});

describe("ToolSet", () => {
  it("exposes its tools and name-sorts their schemas for a cache-stable prefix", () => {
    const set = new ToolSet([tool("write"), tool("apply_patch"), tool("read")]);
    expect(set.has("write")).toBe(true);
    expect(set.has("missing")).toBe(false);
    expect(set.get("read").name).toBe("read");
    expect(set.schemas().map((s) => s.name)).toEqual(["apply_patch", "read", "write"]);
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolSet([tool("dup"), tool("dup")])).toThrow(/duplicate tool/);
  });
});
