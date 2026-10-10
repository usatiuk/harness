import { describe, expect, it } from "vitest";
import { itemSchema } from "./items.ts";
import { wireItemSchema } from "./client-protocol.ts";

describe("itemSchema", () => {
  const message = {
    id: "i1",
    conversationId: "c1",
    turnId: "t1",
    seq: 0,
    parent: null,
    createdAt: 0,
    type: "message",
    content: [{ type: "text", text: "hello" }],
  };

  it.each([undefined, null, "commentary", "final_answer", "provider-phase"])(
    "preserves assistant phase %s at the storage and wire boundaries",
    (phase) => {
      const value = { ...message, role: "assistant", ...(phase !== undefined ? { phase } : {}) };
      expect(itemSchema.parse(value)).toEqual(value);
      const wire = {
        ...message,
        role: "assistant",
        phase: phase === undefined ? null : { value: phase },
      };
      expect(wireItemSchema.parse(wire)).toEqual(wire);
    },
  );

  it.each(["user", "system"])("rejects phases on %s messages", (role) => {
    const value = { ...message, role };
    expect(itemSchema.parse(value)).toEqual(value);
    expect(wireItemSchema.parse(value)).toEqual({ ...value, phase: null });
    for (const phase of [null, "commentary"]) {
      expect(itemSchema.safeParse({ ...value, phase }).success).toBe(false);
      expect(wireItemSchema.safeParse({ ...value, phase: { value: phase } }).success).toBe(false);
    }
  });

  it("round-trips a tool_result item", () => {
    const value = {
      id: "i1",
      conversationId: "c1",
      turnId: "t1",
      seq: 0,
      parent: null,
      createdAt: 0,
      type: "tool_result",
      callId: "call1",
      content: [{ type: "text", text: "ok" }],
      status: "ok",
    };
    expect(itemSchema.parse(value)).toEqual(value);
  });

  it("round-trips namespaced tool-result annotations", () => {
    const parsed = itemSchema.parse({
      id: "i2",
      conversationId: "c1",
      turnId: "t1",
      seq: 1,
      parent: null,
      createdAt: 0,
      type: "tool_result",
      callId: "call-1",
      content: [{ type: "text", text: "ok" }],
      status: "ok",
      annotations: { approval: { decision: "allow", responder: "auto" } },
    });
    expect(parsed).toMatchObject({
      annotations: { approval: { decision: "allow", responder: "auto" } },
    });
  });

  it("round-trips a compaction item", () => {
    const value = {
      id: "i1",
      conversationId: "c1",
      turnId: "t1",
      seq: 0,
      parent: null,
      createdAt: 0,
      type: "compaction",
      content: [{ type: "text", text: "summary" }],
    };
    expect(itemSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown item type", () => {
    expect(() => itemSchema.parse({ type: "nope" })).toThrow();
  });

  it("rejects a malformed content block", () => {
    expect(() =>
      itemSchema.parse({
        id: "i1",
        conversationId: "c1",
        turnId: "t1",
        seq: 0,
        createdAt: 0,
        type: "message",
        role: "user",
        content: [{ type: "image" }],
      }),
    ).toThrow();
  });
});
