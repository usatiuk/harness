import { describe, expect, it } from "vitest";
import { itemSchema } from "./items.ts";

describe("itemSchema", () => {
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
