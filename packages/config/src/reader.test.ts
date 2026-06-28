import { describe, expect, it } from "vitest";
import type { ConfigResolver, ConversationConfig, ConversationId } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { ResolvedConfigReader } from "./reader.ts";

// A stand-in resolver: treat the record's overrides.plugins as the resolved plugin slices.
const resolveFromRecord: ConfigResolver = (record) =>
  Promise.resolve({
    instructions: "",
    model: { provider: "p", model: "m" },
    plugins: (record.overrides.plugins as Record<string, unknown> | undefined) ?? {},
  });

describe("ResolvedConfigReader", () => {
  it("serves a plugin slice from the live runtime's resolved config (configFor hit), {} when absent", async () => {
    const store = new InMemoryStore();
    const conv = await store.createConversation({ workspaceRoot: null, overrides: {} });
    // The live config differs from anything stored — proving the hot path reads configFor, not disk.
    const live: ConversationConfig = {
      instructions: "",
      model: { provider: "p", model: "m" },
      plugins: { demo: { level: "live" } },
    };
    const reader = new ResolvedConfigReader(store, resolveFromRecord, () => live);

    expect(await reader.get("demo", conv.id)).toEqual({ level: "live" });
    expect(await reader.get("missing", conv.id)).toEqual({});
  });

  it("falls back to resolving the stored record when no runtime is live", async () => {
    const store = new InMemoryStore();
    const conv = await store.createConversation({
      workspaceRoot: null,
      overrides: { plugins: { demo: { level: "stored" } } },
    });
    const reader = new ResolvedConfigReader(store, resolveFromRecord, () => undefined);

    expect(await reader.get("demo", conv.id)).toEqual({ level: "stored" });
  });

  it("throws for an unknown conversation on the fallback path", async () => {
    const store = new InMemoryStore();
    const reader = new ResolvedConfigReader(store, resolveFromRecord, () => undefined);
    await expect(reader.get("demo", "nope" as ConversationId)).rejects.toThrow(
      /unknown conversation/,
    );
  });
});
