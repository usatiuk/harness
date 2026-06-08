import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelProvider, ModelStreamEvent } from "@harness/protocol";
import { ProviderRegistry } from "./registry.ts";

const provider = (name: string, models?: ModelInfo[]): ModelProvider => ({
  provider: name,
  capabilities: () => ({ contentTypes: ["text"], toolCalling: true }),
  validateConfig: () => {},
  stream: async function* (): AsyncIterable<ModelStreamEvent> {},
  ...(models ? { listModels: () => models } : {}),
});

describe("ProviderRegistry.listModels", () => {
  it("aggregates catalogs in registration order, skipping providers without one", () => {
    const reg = new ProviderRegistry();
    reg.register(provider("a", [{ provider: "a", model: "a1" }]));
    reg.register(provider("b")); // no listModels → contributes nothing
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
