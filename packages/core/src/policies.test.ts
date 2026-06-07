import { describe, expect, it } from "vitest";
import type {
  ConversationId,
  Item,
  ItemId,
  ProviderPayload,
  ToolCall,
  ToolMiddlewareContext,
} from "@harness/protocol";
import {
  compactedWindow,
  defaultContextPolicy,
  noCompaction,
  truncateMiddleware,
} from "./policies.ts";

const item = (id: string, seq: number): Item => ({
  id: id as ItemId,
  conversationId: "c1" as ConversationId,
  turnId: "t1" as never,
  seq,
  parent: null,
  createdAt: 0,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: id }],
});

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

describe("truncateMiddleware", () => {
  const call: ToolCall = { callId: "1", name: "echo", args: {} };
  const ctx = {} as ToolMiddlewareContext; // truncate ignores ctx

  it("caps long text and leaves short text untouched", async () => {
    const mw = truncateMiddleware(5);
    const long = await mw.wrap(call, ctx, async () => ({
      forModel: [{ type: "text", text: "0123456789" }],
      status: "ok",
    }));
    expect(long.forModel[0]).toEqual({ type: "text", text: "01234…[truncated]" });

    const short = await mw.wrap(call, ctx, async () => ({
      forModel: [{ type: "text", text: "ok" }],
      status: "ok",
    }));
    expect(short.forModel[0]).toEqual({ type: "text", text: "ok" });
  });
});

const compaction = (id: string, seq: number): Item => ({
  id: id as ItemId,
  conversationId: "c1" as ConversationId,
  turnId: "t1" as never,
  seq,
  parent: null,
  createdAt: 0,
  type: "compaction",
  content: [{ type: "text", text: id }],
});

describe("compactedWindow", () => {
  it("returns the chain unchanged when there is no compaction", () => {
    const chain = [item("a", 0), item("b", 1)];
    expect(compactedWindow(chain)).toEqual(chain);
  });

  it("slices at the compaction item, keeping it and everything after", () => {
    const chain = [item("a", 0), compaction("k", 1), item("b", 2)];
    expect(compactedWindow(chain)).toEqual([chain[1], chain[2]]);
  });

  it("bounds at the latest of several compactions", () => {
    const chain = [compaction("k1", 0), item("a", 1), compaction("k2", 2), item("b", 3)];
    expect(compactedWindow(chain)).toEqual([chain[2], chain[3]]);
  });
});

describe("noCompaction", () => {
  it("always skips", async () => {
    expect(
      await noCompaction.compact({ conversationId: "c1" as ConversationId, items: [] }),
    ).toBeNull();
  });
});
