import { describe, expect, it } from "vitest";
import type { ConversationId, Item, ItemId } from "@harness/protocol";
import { reviewerWindow } from "./reviewer-window.ts";

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
const compaction = (id: string, seq: number): Item => ({
  ...item(id, seq),
  type: "compaction",
  content: [{ type: "text", text: id }],
});

describe("reviewerWindow", () => {
  it("retains recent successful child pairs across compaction without duplicating failures", () => {
    const history = Array.from({ length: 20 }, (_, i): Item[] => [
      {
        ...item(`call-${i}`, i * 2),
        type: "tool_call",
        callId: `child-${i}`,
        parentCallId: "eval",
        name: "lookup",
        args: {},
      },
      {
        ...item(`result-${i}`, i * 2 + 1),
        type: "tool_result",
        callId: `child-${i}`,
        parentCallId: "eval",
        status: i === 19 ? "error" : "ok",
        content: [{ type: "text", text: "evidence" }],
      },
    ]).flat();
    const fold = compaction("fold", 40);
    const after = item("after", 41);
    const selected = reviewerWindow([...history, fold, after]);
    expect(selected).toEqual([...history.slice(8), fold, after]);
    expect(new Set(selected.map((item) => item.id)).size).toBe(selected.length);
  });

  it("retains only the last sixteen pre-fold failure pairs and follows the active rewind chain", () => {
    const failures = Array.from({ length: 20 }, (_, i): Item[] => {
      const base = item(`failure-${i}`, i * 2);
      return [
        {
          id: base.id,
          conversationId: base.conversationId,
          turnId: base.turnId,
          seq: base.seq,
          parent: null,
          createdAt: 0,
          type: "tool_call",
          callId: `call-${i}`,
          parentCallId: "eval",
          name: "update",
          args: { i },
        },
        {
          ...base,
          seq: base.seq + 1,
          type: "tool_result",
          callId: `call-${i}`,
          parentCallId: "eval",
          status: "error",
          content: [{ type: "text", text: "denied" }],
        },
      ];
    }).flat();
    const fold = compaction("fold", 40);
    const after = item("after", 41);
    const projected = reviewerWindow([...failures, fold, after]);
    expect(projected).toEqual([...failures.slice(8), fold, after]);
    expect(reviewerWindow([item("before-denial", 0), fold, after])).toEqual([fold, after]);
  });
  it("bounds nested history without waiting for main-agent compaction", () => {
    const history = Array.from({ length: 1024 }, (_, i): Item[] => {
      const base = item(`item-${i}`, i * 2);
      return [
        {
          id: base.id,
          conversationId: base.conversationId,
          turnId: base.turnId,
          seq: base.seq,
          parent: null,
          createdAt: 0,
          type: "tool_call",
          callId: `call-${i}`,
          parentCallId: "outer",
          name: "lookup",
          args: {},
        },
        {
          ...base,
          seq: base.seq + 1,
          type: "tool_result",
          callId: `call-${i}`,
          parentCallId: "outer",
          content: [{ type: "text", text: "output" }],
          status: i < 16 ? "error" : "ok",
        },
      ];
    }).flat();
    expect(reviewerWindow(history)).toEqual([...history.slice(0, 32), ...history.slice(-32)]);
  });
});
