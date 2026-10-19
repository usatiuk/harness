import { describe, expect, it } from "vitest";
import type { ContentBlock, HarnessEvent, Item, Usage } from "@harness/protocol";
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
const worked = (duration = 0): Extract<State["cells"][number], { kind: "worked" }> => ({
  kind: "worked",
  id: "t1:worked",
  duration,
});

describe("transcript reducer", () => {
  it("uses explicit origin for background messages in both live and restored history", () => {
    const messages = [
      item({ type: "message", role: "user", id: "human", content: text("Activity finished") }),
      item({
        type: "message",
        role: "user",
        id: "background",
        source: { kind: "plugin", pluginId: "subagent" },
        content: text("Agent result"),
      }),
    ];
    const restored = init(messages).cells;
    const live = fold(
      messages.map((entry) => ({ type: "item.appended", conversationId: "c", item: entry })),
    ).cells;
    expect(live).toEqual(restored);
    expect(restored).toMatchObject([
      { kind: "user", text: "Activity finished" },
      { kind: "plugin_message", text: "Agent result", pluginId: "subagent" },
    ]);
  });
  it("keeps inherited and fork-owned tool results separate when provider IDs repeat", () => {
    const entries = ["source", "fork"].flatMap((conversationId) => [
      item({
        id: `${conversationId}-call`,
        conversationId,
        turnId: conversationId,
        type: "tool_call",
        callId: "same",
        name: "read",
        args: {},
      }),
      item({
        id: `${conversationId}-result`,
        conversationId,
        turnId: conversationId,
        type: "tool_result",
        callId: "same",
        status: "ok",
        content: text(`${conversationId} output`),
      }),
    ]);
    expect(
      init(entries)
        .cells.filter((cell) => cell.kind === "tool")
        .map((cell) => cell.output),
    ).toEqual(["source output", "fork output"]);
  });
  it("uses client receipt times for live reasoning despite server clock skew", () => {
    const streamed = reduce(
      emptyState,
      { type: "reasoning_delta", turnId: "t1", text: "thought" },
      100_000,
    );
    const durable = item({ type: "reasoning", content: text("thought"), createdAt: 42_000 });
    const completed = reduce(streamed, { type: "item.appended", item: durable }, 102_000);
    expect(completed.cells[0]).toMatchObject({
      startedAt: 100_000,
      completedAt: 102_000,
      observedTiming: true,
    });
    expect(init([durable]).cells[0]).toMatchObject({ startedAt: 42_000, completedAt: 42_000 });
    expect(init([durable]).cells[0]).not.toHaveProperty("observedTiming");
  });
  it.each([undefined, null, "commentary", "final_answer", "other"])(
    "replaces preview phase with canonical %s while preserving display hints",
    (phase) => {
      const hint = item({ type: "provider_output", id: "h1", content: text("Searched example") });
      const message = item({
        type: "message",
        role: "assistant",
        id: "m1",
        content: text("canonical"),
        ...(phase !== undefined ? { phase } : {}),
      });
      const state = fold([
        { type: "text_delta", turnId: "t1", text: "preview", phase: "commentary" },
        { type: "item.appended", item: hint },
        { type: "item.appended", item: message },
      ]);
      expect(state.cells).toHaveLength(2);
      expect(state.cells[1]).toEqual({
        kind: "assistant",
        turnId: "t1",
        text: "canonical",
        streaming: false,
        id: "m1",
        ...(phase !== undefined ? { phase } : {}),
      });
      expect(state.cells[0]).toEqual({
        kind: "provider_output",
        turnId: "t1",
        text: "Searched example",
        id: "h1",
      });
      expect(init([hint, message]).cells).toEqual(state.cells);
    },
  );

  it("streams assistant deltas then finalizes on the message item", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "text_delta", turnId: "t1", text: "Hel" },
      { type: "text_delta", turnId: "t1", text: "lo" },
      {
        type: "item.appended",
        item: item({ type: "message", role: "assistant", id: "m1", content: text("Hello") }),
      },
      { type: "turn.status", turnId: "t1", status: "completed" },
    ]);
    expect(state.cells).toEqual([
      { kind: "assistant", turnId: "t1", text: "Hello", streaming: false, id: "m1" },
      worked(),
    ]);
    expect(state.turn.status).toBe("completed");
  });

  it("orders reasoning, then assistant text, then a tool call", () => {
    const state = fold([
      { type: "reasoning_delta", turnId: "t1", text: "think" },
      {
        type: "item.appended",
        item: item({ type: "reasoning", id: "r1", content: text("think") }),
      },
      { type: "text_delta", turnId: "t1", text: "answer" },
      {
        type: "item.appended",
        item: item({
          type: "tool_call",
          id: "tc1",
          callId: "k1",
          name: "bash",
          args: { cmd: "ls" },
        }),
      },
    ]);
    expect(state.cells.map((c) => c.kind)).toEqual(["reasoning", "assistant", "tool"]);
    expect(state.cells[0]).toMatchObject({ kind: "reasoning", streaming: false });
    expect(state.cells[1]).toMatchObject({ kind: "assistant", text: "answer", streaming: true });
  });

  it("fills a running tool cell by callId on completion", () => {
    const state = fold([
      {
        type: "item.appended",
        item: item({ type: "tool_call", id: "tc1", callId: "k1", name: "bash", args: {} }),
      },
      {
        type: "item.appended",
        item: item({
          type: "tool_result",
          id: "tr1",
          callId: "k1",
          status: "ok",
          content: text("done"),
        }),
      },
    ]);
    expect(state.cells).toEqual([
      {
        kind: "tool",
        id: "tc1",
        conversationId: "c",
        callId: "k1",
        turnId: "t1",
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
      {
        type: "item.appended",
        item: item({ type: "tool_call", id: "tc1", callId: "k1", name: "bash", args: {} }),
      },
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
        type: "item.appended",
        item: item({
          type: "tool_result",
          id: "tr1",
          callId: "k1",
          status: "ok",
          content: text("done"),
          annotations: {
            approval: {
              decision: "allow",
              responder: "auto",
              relationship: "out-of-workspace",
              model: { provider: "fake", model: "reviewer" },
            },
          },
        }),
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
      {
        type: "item.appended",
        item: item({ type: "tool_call", id: "tc1", callId: "k1", name: "bash", args: {} }),
      },
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
        type: "item.appended",
        item: item({
          type: "tool_result",
          id: "tr1",
          callId: "k1",
          status: "error",
          content: text("interrupted"),
        }),
      },
      0,
    );
    expect(interrupted.cells[0]).toMatchObject({ status: "error", output: "interrupted" });
    expect(interrupted.cells[0]).not.toHaveProperty("approvalProgress");
    expect(interrupted.cells[0]).not.toHaveProperty("approval");
  });

  it("sets a pending approval and clears it on resolution", () => {
    const started = reduce(
      { ...emptyState, turn: { id: "t1", status: "running", startedAt: 0 } },
      {
        type: "item.appended",
        conversationId: "c",
        item: item({
          type: "tool_call",
          id: "tc1",
          callId: "k1",
          name: "read_file",
          args: { path: "secret.txt" },
        }),
      },
      0,
    );
    const created = reduce(
      started,
      {
        type: "request.created",
        requestId: "q1",
        conversationId: "c",
        request: {
          kind: "approval",
          call: { callId: "k1", name: "read_file", args: { path: "secret.txt" } },
          relationship: "unknown",
        },
      },
      0,
    );
    expect(created.pending).toEqual([{ requestId: "q1", summary: "approve read_file?" }]);
    expect(created.cells[0]).toMatchObject({
      kind: "tool",
      approvalProgress: { status: "reviewing", responder: "human" },
    });
    const resolved = reduce(
      created,
      {
        type: "request.resolved",
        requestId: "q1",
        conversationId: "c",
      },
      0,
    );
    expect(resolved.pending).toEqual([]);
  });

  it("keeps simultaneous approvals visible until each is resolved", () => {
    const request = (requestId: string, callId: string): HarnessEvent => ({
      type: "request.created",
      requestId,
      conversationId: "c",
      request: {
        kind: "approval",
        call: { callId, name: "bash", args: {} },
        relationship: "unknown",
      },
    });
    const queued = fold([request("q1", "c1"), request("q2", "c2")]);
    expect(queued.pending.map(({ requestId }) => requestId)).toEqual(["q1", "q2"]);
    const remaining = reduce(
      queued,
      { type: "request.resolved", requestId: "q1", conversationId: "c" },
      0,
    );
    expect(remaining.pending.map(({ requestId }) => requestId)).toEqual(["q2"]);
  });

  it("clears a pending approval when the turn ends without an explicit resolve", () => {
    const created = reduce(
      { ...emptyState, turn: { id: "t1", status: "running", startedAt: 0 } },
      {
        type: "request.created",
        requestId: "q1",
        conversationId: "c",
        request: {
          kind: "approval",
          call: { callId: "k1", name: "bash", args: { command: "echo hi" } },
          relationship: "unknown",
        },
      },
      0,
    );
    const ended = reduce(created, { type: "turn.status", turnId: "t1", status: "aborted" }, 0);
    expect(ended.pending).toEqual([]);
  });

  it("appends an error cell carrying the message when a turn fails", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "turn.status", turnId: "t1", status: "failed", error: "404 model unavailable" },
    ]);
    expect(state.cells).toEqual([
      { kind: "error", id: "t1:error", text: "404 model unavailable" },
      worked(),
    ]);
    expect(state.turn.status).toBe("failed");
  });

  it("keeps compaction content for the verbose transcript", () => {
    const state = fold([
      {
        type: "item.appended",
        item: item({ type: "compaction", id: "fold-1", content: text("Earlier work") }),
      },
    ]);
    expect(state.cells).toEqual([{ kind: "compaction", id: "fold-1", text: "Earlier work" }]);
  });

  it("restores compaction content for the verbose transcript", () => {
    const state = init([item({ type: "compaction", id: "fold-1", content: text("Earlier work") })]);
    expect(state.cells).toEqual([{ kind: "compaction", id: "fold-1", text: "Earlier work" }]);
  });

  it("deduplicates a durable item present in history and the live suffix", () => {
    const durable = item({
      type: "message",
      role: "assistant",
      id: "m1",
      content: text("once"),
    });
    const seeded = init([durable]);
    const repeated = reduce(seeded, { type: "item.appended", item: durable }, 0);
    expect(repeated).toBe(seeded);
    expect(repeated.cells).toHaveLength(1);
  });

  it("removes a streamed draft when history already contains its canonical item", () => {
    const durable = item({
      type: "message",
      role: "assistant",
      id: "m1",
      content: text("canonical"),
    });
    const seeded = init([durable]);
    const withOverlappingDelta = reduce(
      seeded,
      { type: "text_delta", turnId: "t1", text: "canonical" },
      0,
    );
    const reconciled = reduce(withOverlappingDelta, { type: "item.appended", item: durable }, 0);

    expect(reconciled.cells).toEqual([
      { kind: "assistant", turnId: "t1", text: "canonical", streaming: false, id: "m1" },
    ]);
  });

  it("records elapsed work without an error cell for an aborted turn", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      { type: "turn.status", turnId: "t1", status: "aborted" },
    ]);
    expect(state.cells).toEqual([worked()]);
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
        observedTiming: true,
      },
      { kind: "assistant", turnId: "t1", text: "partial answer", streaming: false },
      worked(),
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
      worked(),
    ]);
  });

  it("settles a tool when its turn fails before a completion event", () => {
    const state = fold([
      { type: "turn.status", turnId: "t1", status: "running" },
      {
        type: "item.appended",
        item: item({
          type: "tool_call",
          id: "tc1",
          callId: "k1",
          name: "bash",
          args: { command: "work" },
        }),
      },
      { type: "turn.status", turnId: "t1", status: "failed", error: "provider disconnected" },
    ]);
    expect(state.cells).toEqual([
      {
        kind: "tool",
        id: "tc1",
        conversationId: "c",
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
      worked(),
    ]);
  });

  it("records observed turn duration once and does not reconstruct it from items", () => {
    const running = reduce(
      emptyState,
      { type: "turn.status", conversationId: "c", turnId: "t1", status: "running" },
      1_000,
    );
    const completed = reduce(
      running,
      { type: "turn.status", conversationId: "c", turnId: "t1", status: "completed" },
      4_250,
    );
    const duplicate = reduce(
      completed,
      {
        type: "turn.status",
        conversationId: "c",
        turnId: "t1",
        status: "failed",
        error: "late failure",
      },
      5_000,
    );
    const next = reduce(
      duplicate,
      { type: "turn.status", conversationId: "c", turnId: "t2", status: "running" },
      6_000,
    );
    const stale = reduce(
      next,
      {
        type: "turn.status",
        conversationId: "c",
        turnId: "t1",
        status: "failed",
        error: "stale failure",
      },
      7_000,
    );

    expect(completed.cells).toEqual([worked(3_250)]);
    expect(duplicate).toBe(completed);
    expect(stale).toBe(next);
    expect(stale.turn).toEqual({ id: "t2", status: "running", startedAt: 6_000 });
    expect(
      init([item({ type: "message", role: "user", id: "u1", content: text("hello") })]).cells,
    ).not.toContainEqual(expect.objectContaining({ kind: "worked" }));
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
      ...log.map((entry) => ({ type: "item.appended" as const, item: entry })),
    ]);

    expect(seeded.cells).toEqual(replayed.cells);
    expect(seeded.cells).toEqual([
      { kind: "user", id: "u1", turnId: "t1", text: "hi", createdAt: 0 },
      {
        kind: "tool",
        id: "tc1",
        conversationId: "c",
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

  it("replaces usage with the latest authoritative summary", () => {
    const usageEvent = (usage: Usage, cost: number, lastInputTokens: number): HarnessEvent => ({
      type: "usage.changed",
      conversationId: "c",
      summary: { usage, incomplete: false, cost, lastInputTokens },
    });
    const state = fold([
      usageEvent({ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 0 }, 0.01, 1000),
      usageEvent({ inputTokens: 2500, outputTokens: 150, cachedReadTokens: 900 }, 0.01, 1500),
    ]);
    expect(state.usage).toEqual({ inputTokens: 2500, outputTokens: 150, cachedReadTokens: 900 });
    expect(state.cost).toBeCloseTo(0.01, 10);
    expect(state.lastInputTokens).toBe(1500); // latest step, not the sum — the ctx-fill numerator
  });

  it("marks totals incomplete and clears the latest checkpoint when usage is unknown", () => {
    const known: HarnessEvent = {
      type: "usage.changed",
      conversationId: "c",
      summary: {
        usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 },
        incomplete: false,
        cost: 0.01,
        lastInputTokens: 100,
      },
    };
    const unknown: HarnessEvent = {
      type: "usage.changed",
      conversationId: "c",
      summary: {
        usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 },
        incomplete: true,
        cost: 0.01,
      },
    };
    const state = fold([known, unknown]);
    expect(state.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 });
    expect(state.usageIncomplete).toBe(true);
    expect(state.lastInputTokens).toBeUndefined();
  });

  it("seeds authoritative usage totals on resume", () => {
    const seeded = init([], {
      usage: { inputTokens: 500, outputTokens: 50, cachedReadTokens: 150 },
      cost: 0.03,
      incomplete: false,
      lastInputTokens: 300,
    });
    expect(seeded.usage).toEqual({ inputTokens: 500, outputTokens: 50, cachedReadTokens: 150 });
    expect(seeded.cost).toBeCloseTo(0.03, 10);
    expect(seeded.lastInputTokens).toBe(300);
    expect(init([]).lastInputTokens).toBeUndefined();
  });

  it("restores the server's incomplete usage state without a stale input checkpoint", () => {
    const seeded = init([], {
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
      cost: 0,
      incomplete: true,
      costIncomplete: true,
    });
    expect(seeded).toMatchObject({ usageIncomplete: true, costIncomplete: true });
    expect(seeded.lastInputTokens).toBeUndefined();
  });

  it("restores lower-bound totals after retries without losing known context usage", () => {
    const usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 };
    expect(
      init([], {
        usage,
        cost: 0.01,
        incomplete: true,
        costIncomplete: true,
        lastInputTokens: 100,
      }),
    ).toMatchObject({
      usage,
      cost: 0.01,
      usageIncomplete: true,
      costIncomplete: true,
      lastInputTokens: 100,
    });
  });

  it("restores cumulative billing totals without presenting them as context fill", () => {
    const usage = { inputTokens: 20_000, outputTokens: 2, cachedReadTokens: 0 };
    const state = init([], {
      usage,
      cost: 1,
      incomplete: false,
    });
    expect(state.usage).toEqual(usage);
    expect(state.cost).toBe(1);
    expect(state.lastInputTokens).toBeUndefined();
  });

  it("mirrors the inbox snapshot into pendingInput", () => {
    const state = fold([
      {
        type: "inbox",
        conversationId: "c",
        pending: [{ intent: "queue", text: "later", source: { kind: "user" } }],
      },
    ]);
    expect(state.pendingInput).toEqual([
      { intent: "queue", text: "later", source: { kind: "user" } },
    ]);
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
    expect(started.activities).toEqual([
      { conversationId: "c", id: "a1", kind: "process", title: "npm run dev" },
    ]);
    const exited = fold(
      [{ type: "activity.exited", conversationId: "c", id: "a1", status: "ok", summary: "exit 0" }],
      started,
    );
    expect(exited.activities).toEqual([
      {
        conversationId: "c",
        id: "a1",
        kind: "process",
        title: "npm run dev",
        status: "ok",
        summary: "exit 0",
      },
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

it("preserves user and tool images through live events and restored history", () => {
  const image: ContentBlock = {
    type: "image",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GQAAAAASUVORK5CYII=",
  };
  const entries = [
    item({ id: "image-user", type: "message", role: "user", content: [image] }),
    item({
      id: "image-call",
      type: "tool_call",
      callId: "read-image",
      name: "read_file",
      args: {},
    }),
    item({
      id: "image-result",
      type: "tool_result",
      callId: "read-image",
      status: "ok",
      content: [...text("Screenshot"), image],
    }),
  ];
  const restored = init(entries).cells;
  const live = fold(
    entries.map((entry) => ({ type: "item.appended", conversationId: "c", item: entry })),
  ).cells;
  expect(live).toEqual(restored);
  expect(restored).toMatchObject([
    { kind: "user", text: "", images: [image] },
    { kind: "tool", output: "Screenshot", images: [image] },
  ]);
});

describe("model retry status", () => {
  const retry = (attempt: number, purpose = "agent"): HarnessEvent => ({
    type: "model.retry",
    conversationId: "c",
    purpose,
    attempt,
    maxAttempts: 5,
    delayMs: 1200,
    reason: "rate_limit",
  });

  it("folds the latest scheduled retry as transient status", () => {
    const state = fold([retry(2), retry(3)]);
    expect(state.modelRetry).toEqual({
      purpose: "agent",
      attempt: 3,
      maxAttempts: 5,
      delayMs: 1200,
      reason: "rate_limit",
    });
  });

  it("clears retry status when model output resumes", () => {
    for (const resumed of [
      { type: "text_delta", conversationId: "c", turnId: "t1", text: "ok" },
      { type: "reasoning_delta", conversationId: "c", turnId: "t1", text: "hmm" },
    ] satisfies HarnessEvent[]) {
      const state = fold([
        { type: "turn.status", conversationId: "c", turnId: "t1", status: "running" },
        retry(2),
        resumed,
      ]);
      expect(state.modelRetry).toBeUndefined();
    }
  });

  it("clears retry status for finalized model-owned items without deltas", () => {
    for (const output of [
      item({ type: "message", role: "assistant", content: text("done") }),
      item({ type: "reasoning", content: text("thought") }),
      item({ type: "provider_output", content: text("searched") }),
      item({ type: "tool_call", callId: "call", name: "echo", args: {} }),
      item({ type: "compaction", content: text("summary") }),
    ]) {
      const state = fold([
        { type: "turn.status", conversationId: "c", turnId: "t1", status: "running" },
        retry(2, output.type === "compaction" ? "compaction" : "agent"),
        { type: "item.appended", conversationId: "c", item: output },
      ]);
      expect(state.modelRetry, output.type).toBeUndefined();
    }
  });

  it("keeps retry status across unrelated appends and nested tool calls", () => {
    for (const unrelated of [
      item({ type: "message", role: "user", content: text("queued") }),
      item({ type: "message", role: "system", content: text("system") }),
      item({
        type: "message",
        role: "user",
        source: { kind: "plugin", pluginId: "test" },
        content: text("notice"),
      }),
      item({ type: "context", key: "context", content: text("context") }),
      item({ type: "tool_result", callId: "call", content: text("done"), status: "ok" }),
      item({ type: "tool_call", callId: "nested", parentCallId: "call", name: "echo", args: {} }),
    ]) {
      const state = fold([
        { type: "turn.status", conversationId: "c", turnId: "t1", status: "running" },
        retry(2),
        { type: "item.appended", conversationId: "c", item: unrelated },
      ]);
      expect(state.modelRetry, unrelated.type).toEqual({
        purpose: "agent",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1200,
        reason: "rate_limit",
      });
    }
  });

  it("clears retry status when the turn settles or a new turn starts", () => {
    const settled = fold([
      { type: "turn.status", conversationId: "c", turnId: "t1", status: "running" },
      retry(2),
      {
        type: "turn.status",
        conversationId: "c",
        turnId: "t1",
        status: "failed",
        error: "gave up",
      },
    ]);
    expect(settled.modelRetry).toBeUndefined();
    const restarted = fold([
      retry(2),
      { type: "turn.status", conversationId: "c", turnId: "t2", status: "running" },
    ]);
    expect(restarted.modelRetry).toBeUndefined();
  });
});
