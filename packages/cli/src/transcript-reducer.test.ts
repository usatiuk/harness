import { describe, expect, it } from "vitest";
import type { ContentBlock, HarnessEvent, Item, ModelUsage, Usage } from "@harness/protocol";
import { emptyState, init, reduce, type State } from "./transcript-reducer.ts";

const text = (t: string): ContentBlock[] => [{ type: "text", text: t }];

/** Minimal Item builder; the reducer only reads the fields it switches on (ids unbranded). */
const item = (over: { type: Item["type"] } & Record<string, unknown>): Item =>
  ({
    id: "i",
    conversationId: "c",
    turnId: "t1",
    seq: 0,
    parent: null,
    createdAt: 0,
    ...over,
  }) as Item;

const fold = (events: HarnessEvent[], from: State = emptyState): State =>
  events.reduce((state, event) => reduce(state, event, 0), from);

describe("transcript reducer", () => {
  it("streams assistant deltas then finalizes on the message item", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "text_delta", turnId: "t1", text: "Hel" },
      { type: "text_delta", turnId: "t1", text: "lo" },
      {
        type: "message",
        item: item({ type: "message", role: "assistant", id: "m1", content: text("Hello") }),
      },
      { type: "turn.status", turnId: "t1", status: "completed" },
    ]);
    expect(state.cells).toEqual([
      { kind: "assistant", turnId: "t1", text: "Hello", streaming: false, id: "m1" },
    ]);
    expect(state.turn.status).toBe("completed");
  });

  it("orders reasoning, then assistant text, then a tool call", () => {
    const state = fold([
      { type: "reasoning_delta", turnId: "t1", text: "think" },
      { type: "reasoning", item: item({ type: "reasoning", id: "r1", content: text("think") }) },
      { type: "text_delta", turnId: "t1", text: "answer" },
      { type: "tool_call.started", callId: "k1", name: "bash", args: { cmd: "ls" } },
    ]);
    expect(state.cells.map((c) => c.kind)).toEqual(["reasoning", "assistant", "tool"]);
    expect(state.cells[0]).toMatchObject({ kind: "reasoning", streaming: false });
    expect(state.cells[1]).toMatchObject({ kind: "assistant", text: "answer", streaming: true });
  });

  it("fills a running tool cell by callId on completion", () => {
    const state = fold([
      { type: "tool_call.started", callId: "k1", name: "bash", args: {} },
      { type: "tool_call.completed", callId: "k1", status: "ok", forModel: text("done") },
    ]);
    expect(state.cells).toEqual([
      {
        kind: "tool",
        callId: "k1",
        name: "bash",
        args: {},
        startedAt: 0,
        completedAt: 0,
        status: "ok",
        output: "done",
      },
    ]);
  });

  it("shows live auto-review progress, then keeps the durable approval annotation", () => {
    const running = fold([
      { type: "tool_call.started", callId: "k1", name: "bash", args: {} },
      {
        type: "auto-approval.reviewing",
        conversationId: "c",
        callId: "k1",
        name: "bash",
        model: { provider: "fake", model: "reviewer" },
      },
      {
        type: "approval.decided",
        conversationId: "c",
        callId: "k1",
        decision: "allow",
        responder: "auto",
        model: { provider: "fake", model: "reviewer" },
      },
    ]);
    expect(running.cells[0]).toMatchObject({
      kind: "tool",
      approvalProgress: {
        status: "allow",
        responder: "auto",
        model: { provider: "fake", model: "reviewer" },
      },
    });

    const completed = reduce(
      running,
      {
        type: "tool_call.completed",
        callId: "k1",
        status: "ok",
        forModel: text("done"),
        annotations: {
          approval: {
            decision: "allow",
            responder: "auto",
            relationship: "out-of-workspace",
            model: { provider: "fake", model: "reviewer" },
          },
        },
      },
      0,
    );
    expect(completed.cells[0]).toMatchObject({
      approval: {
        decision: "allow",
        responder: "auto",
        model: { provider: "fake", model: "reviewer" },
      },
    });
    expect(completed.cells[0]).not.toHaveProperty("approvalProgress");
  });

  it("clears reviewing progress when interruption completes without a decision", () => {
    const reviewing = fold([
      { type: "tool_call.started", callId: "k1", name: "bash", args: {} },
      {
        type: "auto-approval.reviewing",
        conversationId: "c",
        callId: "k1",
        name: "bash",
        model: { provider: "fake", model: "reviewer" },
      },
    ]);
    const interrupted = reduce(
      reviewing,
      {
        type: "tool_call.completed",
        callId: "k1",
        status: "error",
        forModel: text("interrupted"),
      },
      0,
    );
    expect(interrupted.cells[0]).toMatchObject({ status: "error", output: "interrupted" });
    expect(interrupted.cells[0]).not.toHaveProperty("approvalProgress");
    expect(interrupted.cells[0]).not.toHaveProperty("approval");
  });

  it("sets a pending approval and clears it on resolution", () => {
    const created = reduce(
      emptyState,
      {
        type: "request.created",
        requestId: "q1",
        conversationId: "c",
        request: { kind: "approval", call: { name: "bash" } },
      },
      0,
    );
    expect(created.pending).toEqual({ requestId: "q1", summary: "approve bash?" });
    const resolved = reduce(
      created,
      {
        type: "request.resolved",
        requestId: "q1",
        conversationId: "c",
      },
      0,
    );
    expect(resolved.pending).toBeUndefined();
  });

  it("clears a pending approval when the turn ends without an explicit resolve", () => {
    const created = reduce(
      { ...emptyState, turn: { id: "t1", status: "running" } },
      {
        type: "request.created",
        requestId: "q1",
        conversationId: "c",
        request: { kind: "approval", call: { name: "bash" } },
      },
      0,
    );
    const ended = reduce(created, { type: "turn.status", turnId: "t1", status: "aborted" }, 0);
    expect(ended.pending).toBeUndefined();
  });

  it("appends an error cell carrying the message when a turn fails", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "turn.status", turnId: "t1", status: "failed", error: "404 model unavailable" },
    ]);
    expect(state.cells).toEqual([{ kind: "error", id: "t1:error", text: "404 model unavailable" }]);
    expect(state.turn.status).toBe("failed");
  });

  it("keeps compaction content for the verbose transcript", () => {
    const state = fold([
      {
        type: "compaction",
        item: item({ type: "compaction", id: "fold-1", content: text("Earlier work") }),
      },
    ]);
    expect(state.cells).toEqual([{ kind: "compaction", id: "fold-1", text: "Earlier work" }]);
  });

  it("restores compaction content for the verbose transcript", () => {
    const state = init([item({ type: "compaction", id: "fold-1", content: text("Earlier work") })]);
    expect(state.cells).toEqual([{ kind: "compaction", id: "fold-1", text: "Earlier work" }]);
  });

  it("does not append an error cell for an aborted turn", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "turn.status", turnId: "t1", status: "aborted" },
    ]);
    expect(state.cells).toEqual([]);
  });

  it("closes partial assistant and reasoning streams when a turn is aborted", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "reasoning_delta", turnId: "t1", text: "partial thought" },
      { type: "text_delta", turnId: "t1", text: "partial answer" },
      { type: "turn.status", turnId: "t1", status: "aborted" },
    ]);
    expect(state.cells).toEqual([
      {
        kind: "reasoning",
        turnId: "t1",
        text: "partial thought",
        streaming: false,
        startedAt: 0,
        completedAt: 0,
      },
      { kind: "assistant", turnId: "t1", text: "partial answer", streaming: false },
    ]);
  });

  it("closes a still-streaming cell when its turn fails mid-stream", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "text_delta", turnId: "t1", text: "partial" },
      { type: "turn.status", turnId: "t1", status: "failed", error: "boom" },
    ]);
    expect(state.cells).toEqual([
      { kind: "assistant", turnId: "t1", text: "partial", streaming: false },
      { kind: "error", id: "t1:error", text: "boom" },
    ]);
  });

  it("settles a tool when its turn fails before a completion event", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      {
        type: "tool_call.started",
        callId: "k1",
        name: "bash",
        args: { command: "work" },
      },
      { type: "turn.status", turnId: "t1", status: "failed", error: "provider disconnected" },
    ]);
    expect(state.cells).toEqual([
      {
        kind: "tool",
        callId: "k1",
        turnId: "t1",
        name: "bash",
        args: { command: "work" },
        startedAt: 0,
        completedAt: 0,
        status: "error",
        output: "provider disconnected",
      },
      { kind: "error", id: "t1:error", text: "provider disconnected" },
    ]);
  });

  it("init folds a committed log into the same cells a live replay yields", () => {
    const log: Item[] = [
      item({ type: "message", role: "user", id: "u1", seq: 0, content: text("hi") }),
      item({
        type: "tool_call",
        id: "tc1",
        seq: 1,
        callId: "k1",
        name: "bash",
        args: { cmd: "ls" },
      }),
      item({
        type: "tool_result",
        id: "tr1",
        seq: 2,
        callId: "k1",
        status: "ok",
        content: text("files"),
        annotations: {
          approval: {
            decision: "allow",
            responder: "auto",
            relationship: "out-of-workspace",
          },
        },
      }),
      item({ type: "message", role: "assistant", id: "a1", seq: 3, content: text("done") }),
    ];
    const seeded = init(log);

    const replayed = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "message", item: log[0]! },
      { type: "tool_call.started", callId: "k1", name: "bash", args: { cmd: "ls" } },
      {
        type: "tool_call.completed",
        callId: "k1",
        status: "ok",
        forModel: text("files"),
        annotations: {
          approval: {
            decision: "allow",
            responder: "auto",
            relationship: "out-of-workspace",
          },
        },
      },
      { type: "message", item: log[3]! },
    ]);

    expect(seeded.cells).toEqual(replayed.cells);
    expect(seeded.cells).toEqual([
      { kind: "user", id: "u1", turnId: "t1", text: "hi", createdAt: 0 },
      {
        kind: "tool",
        callId: "k1",
        turnId: "t1",
        name: "bash",
        args: { cmd: "ls" },
        startedAt: 0,
        completedAt: 0,
        status: "ok",
        output: "files",
        approval: {
          decision: "allow",
          responder: "auto",
          relationship: "out-of-workspace",
        },
      },
      { kind: "assistant", turnId: "t1", text: "done", streaming: false, id: "a1" },
    ]);
  });

  it("accumulates usage totals, cost, and the latest input size", () => {
    const usageEvent = (usage: Usage, cost: number | null): HarnessEvent => ({
      type: "usage",
      conversationId: "c",
      turnId: "t1",
      provider: "fake",
      model: "fake-1",
      usage,
      cost,
    });
    const state = fold([
      usageEvent({ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 0 }, 0.01),
      usageEvent({ inputTokens: 1500, outputTokens: 100, cachedReadTokens: 900 }, null),
    ]);
    expect(state.usage).toEqual({ inputTokens: 2500, outputTokens: 150, cachedReadTokens: 900 });
    expect(state.cost).toBeCloseTo(0.01, 10);
    expect(state.lastInputTokens).toBe(1500); // latest step, not the sum — the ctx-fill numerator
  });

  it("seeds totals from stored usage rows on resume", () => {
    const row = (id: string, usage: Usage, cost: number | null): ModelUsage => ({
      id,
      conversationId: "c" as ModelUsage["conversationId"],
      turnId: "t1" as ModelUsage["turnId"],
      contextBuildId: null,
      provider: "fake",
      model: "fake-1",
      usage,
      cost,
      createdAt: 0,
    });
    const seeded = init(
      [],
      [
        row("u1", { inputTokens: 200, outputTokens: 20, cachedReadTokens: 0 }, 0.02),
        row("u2", { inputTokens: 300, outputTokens: 30, cachedReadTokens: 150 }, 0.01),
      ],
    );
    expect(seeded.usage).toEqual({ inputTokens: 500, outputTokens: 50, cachedReadTokens: 150 });
    expect(seeded.cost).toBeCloseTo(0.03, 10);
    expect(seeded.lastInputTokens).toBe(300);
    expect(init([]).lastInputTokens).toBeUndefined(); // no rows → no ctx-fill yet
  });

  it("mirrors the inbox snapshot into pendingInput", () => {
    const state = fold([
      { type: "inbox", conversationId: "c", pending: [{ intent: "queue", text: "later" }] },
    ]);
    expect(state.pendingInput).toEqual([{ intent: "queue", text: "later" }]);
    const drained = fold([{ type: "inbox", conversationId: "c", pending: [] }], state);
    expect(drained.pendingInput).toEqual([]);
  });

  it("appends an activity on start and marks it settled on exit", () => {
    const started = fold([
      {
        type: "activity.started",
        conversationId: "c",
        id: "a1",
        kind: "process",
        title: "npm run dev",
      },
    ]);
    expect(started.activities).toEqual([{ id: "a1", kind: "process", title: "npm run dev" }]);
    const exited = fold(
      [{ type: "activity.exited", conversationId: "c", id: "a1", status: "ok", summary: "exit 0" }],
      started,
    );
    expect(exited.activities).toEqual([
      { id: "a1", kind: "process", title: "npm run dev", status: "ok", summary: "exit 0" },
    ]);
  });

  it("folds the latest sandbox.status phase", () => {
    const building = fold([
      { type: "sandbox.status", conversationId: "c", phase: "build", message: "pulling image" },
    ]);
    expect(building.sandbox).toEqual({ phase: "build", message: "pulling image" });
    const ready = fold([{ type: "sandbox.status", conversationId: "c", phase: "ready" }], building);
    expect(ready.sandbox).toEqual({ phase: "ready" });
  });
});
