import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@harness/store";
import { StoreConfigReader } from "./reader.ts";

describe("StoreConfigReader", () => {
  it("serves a plugin's slice from the conversation snapshot, and {} when absent", async () => {
    const store = new InMemoryStore();
    const conv = await store.createConversation({
      config: {
        instructions: "",
        model: { provider: "p", model: "m" },
        plugins: { demo: { level: "high" } },
      },
    });
    const reader = new StoreConfigReader(store);

    expect(await reader.get("demo", conv.id)).toEqual({ level: "high" });
    expect(await reader.get("missing", conv.id)).toEqual({});
  });
});
