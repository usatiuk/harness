import { afterEach, expect, it, vi } from "vitest";
import { reduce, type Cell } from "@harness/client-features/transcript-reducer";
import type { ConversationId, TurnId } from "@harness/protocol";
import { ConversationView } from "./conversation-view.ts";

const id = "conversation" as ConversationId;
const turnId = "turn" as TurnId;
function fixture() {
  const view = new ConversationView({
    id,
    workspaceRoot: null,
    overrides: {},
    head: null,
    title: null,
    createdAt: 0,
    lastUsedAt: 0,
    config: { instructions: "Test", model: { provider: "fake", model: "test" } },
  });
  view.state = { ...view.state, turn: { id: turnId, status: "running", startedAt: 0 } };
  view.publish();
  return view;
}
function delta(
  view: ConversationView,
  text: string,
  kind: "text_delta" | "reasoning_delta" = "text_delta",
) {
  view.state = reduce(view.state, { type: kind, conversationId: id, turnId, text }, Date.now());
  view.publish(true);
}
afterEach(() => vi.useRealTimers());

it("publishes at most ten text/reasoning updates per second without losing trailing content", () => {
  vi.useFakeTimers();
  const view = fixture();
  const notify = vi.fn();
  view.subscribe(notify);
  const project = vi.spyOn(view.transcript, "update");
  for (let index = 0; index < 1000; index++) {
    delta(view, "a");
    delta(view, "r", "reasoning_delta");
    vi.advanceTimersByTime(1);
  }
  expect(notify).toHaveBeenCalledTimes(10);
  expect(project).toHaveBeenCalledTimes(10);
  expect(view.snapshot().state.cells).toEqual([
    expect.objectContaining({ kind: "assistant", text: "a".repeat(1000) }),
    expect.objectContaining({ kind: "reasoning", text: "r".repeat(1000) }),
  ]);
  expect(vi.getTimerCount()).toBe(0);
  view.dispose();
});

it("keeps snapshots stable during a burst and reuses unchanged long-history rows", () => {
  vi.useFakeTimers();
  const view = fixture();
  const history: Cell[] = Array.from({ length: 1000 }, (_, index) => ({
    kind: "assistant",
    id: `old-${index}`,
    turnId: `old-turn-${index}`,
    text: `Message ${index}`,
    streaming: false,
  }));
  view.state = { ...view.state, cells: history };
  view.publish();
  const previous = view.snapshot();
  const notify = vi.fn();
  view.subscribe(notify);
  for (let index = 0; index < 500; index++) delta(view, "x");
  expect(view.snapshot()).toBe(previous);
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(99);
  expect(view.snapshot()).toBe(previous);
  vi.advanceTimersByTime(1);
  expect(notify).toHaveBeenCalledTimes(1);
  const next = view.snapshot();
  expect(next.state.cells.at(-1)).toMatchObject({ text: "x".repeat(500) });
  expect(
    next.transcript.rows
      .slice(0, 1000)
      .every((row, index) => row === previous.transcript.rows[index]),
  ).toBe(true);
  expect(previous.state.cells).toHaveLength(1000);
  expect(previous.transcript.rows).toHaveLength(1000);
  view.dispose();
});

it.each(["completed", "failed", "aborted"] as const)(
  "publishes %s immediately with all preceding text and no stale trailing tick",
  (status) => {
    vi.useFakeTimers();
    const view = fixture();
    const previous = view.snapshot();
    const notify = vi.fn();
    view.subscribe(notify);
    delta(view, "Last words");
    view.state = {
      ...view.state,
      turn: { id: turnId, status },
      cells: view.state.cells.map((cell) =>
        cell.kind === "assistant" ? { ...cell, streaming: false } : cell,
      ),
    };
    view.publish();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(view.snapshot().state).toMatchObject({
      turn: { status },
      cells: [{ text: "Last words", streaming: false }],
    });
    expect(previous.state.cells).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    view.dispose();
  },
);

it("cancels pending publication when its attachment is removed", () => {
  vi.useFakeTimers();
  const view = fixture();
  const snapshot = view.snapshot();
  const notify = vi.fn();
  view.subscribe(notify);
  delta(view, "Pending");
  view.dispose();
  vi.advanceTimersByTime(100);
  expect(notify).not.toHaveBeenCalled();
  expect(view.snapshot()).toBe(snapshot);
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes a control change together with pending text, preserving old maps", () => {
  vi.useFakeTimers();
  const view = fixture();
  const snapshot = view.snapshot();
  delta(view, "Before approval");
  view.approvals = new Map(view.approvals).set("approval", {
    requestId: "approval",
    rootConversationId: id,
    conversationId: id,
    call: { callId: "call", name: "bash", args: {} },
    relationship: null,
  });
  view.publish();
  expect(view.snapshot().approvals.has("approval")).toBe(true);
  expect(view.snapshot().state.cells.at(-1)).toMatchObject({ text: "Before approval" });
  expect(snapshot.approvals.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  view.dispose();
});
