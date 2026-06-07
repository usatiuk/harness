import { describe, expect, it } from "vitest";
import type { ConversationId, Item, ItemId, OutputRef, ProviderPayload } from "@harness/protocol";
import { allowAllToolGate, defaultContextPolicy, truncateOutputProjection } from "./policies.ts";

const item = (id: string, seq: number): Item => ({
  id: id as ItemId,
  conversationId: "c1" as ConversationId,
  turnId: "t1" as never,
  seq,
  createdAt: 0,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: id }],
});

const noBlob = {
  toolName: "echo",
  putBlob: (): Promise<OutputRef> => {
    throw new Error("putBlob should not be called");
  },
};

describe("defaultContextPolicy", () => {
  it("selects all items in order and attaches matching payloads", async () => {
    const a = item("a", 0);
    const b = item("b", 1);
    const payload: ProviderPayload = {
      itemId: a.id,
      provider: "fake",
      model: "m",
      type: "reasoning",
      version: 1,
      payload: {},
    };
    const build = await defaultContextPolicy.select({
      conversationId: "c1" as ConversationId,
      instructions: [{ type: "text", text: "sys" }],
      tools: [],
      items: [a, b],
      payloads: new Map<ItemId, ProviderPayload>([[a.id, payload]]),
    });
    expect(build.instructions).toEqual([{ type: "text", text: "sys" }]);
    expect(build.items).toEqual([{ item: a, payload }, { item: b }]);
  });
});

describe("allowAllToolGate", () => {
  it("allows every call", async () => {
    expect(await allowAllToolGate.evaluate({ callId: "1", name: "x", args: {} })).toBe("allow");
  });
});

describe("truncateOutputProjection", () => {
  it("caps long text and leaves short text untouched", async () => {
    const projection = truncateOutputProjection(5);
    const long = await projection.project(
      { forModel: [{ type: "text", text: "0123456789" }], status: "ok" },
      noBlob,
    );
    expect(long.forModel[0]).toEqual({ type: "text", text: "01234…[truncated]" });

    const short = await projection.project(
      { forModel: [{ type: "text", text: "ok" }], status: "ok" },
      noBlob,
    );
    expect(short.forModel[0]).toEqual({ type: "text", text: "ok" });
  });
});
