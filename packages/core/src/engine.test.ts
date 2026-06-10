import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isKernelEvent } from "@harness/protocol";
import type {
  ContentBlock,
  DeliveryInput,
  HarnessEvent,
  Item,
  ModelMiddleware,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  Plugin,
  Tool,
  ToolMiddleware,
} from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import {
  approvalMiddleware,
  counterIdGenerator,
  EchoTool,
  fakeCompaction,
  FakeProvider,
  type FakeStep,
  fixedClock,
  GateProvider,
  GateTool,
  interleavedStep,
  reasoningStep,
  textStep,
  toolStep,
} from "@harness/testkit";
import { PluginHost } from "./plugin-host.ts";
import { Engine } from "./engine.ts";
import { reconcileConversation } from "./reconcile.ts";

const CONFIG = {
  instructions: "be helpful",
  model: { provider: "fake", model: "fake-1" },
};

const userInput = (text: string): DeliveryInput => ({
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

/** A pure interrupt carries no content. */
const noContent: DeliveryInput = { source: { kind: "user" }, content: [] };

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

const toolCalls = (items: Item[]) =>
  items.filter((i): i is Extract<Item, { type: "tool_call" }> => i.type === "tool_call");
const toolResults = (items: Item[]) =>
  items.filter((i): i is Extract<Item, { type: "tool_result" }> => i.type === "tool_result");

/** A compact, order-preserving fingerprint of the item log for assertions. */
const shapeOf = (items: Item[]): string[] =>
  items.map((i) => {
    if (i.type === "message") return `${i.role}:${textOf(i.content)}`;
    if (i.type === "reasoning") return `reasoning:${textOf(i.content)}`;
    if (i.type === "tool_call") return `call:${i.callId}`;
    if (i.type === "compaction") return `compaction:${textOf(i.content)}`;
    if (i.type === "context") return `context:${i.key}`;
    return `result:${i.callId}`;
  });

const userTexts = (items: Item[]): string[] =>
  items
    .filter(
      (i): i is Extract<Item, { type: "message" }> => i.type === "message" && i.role === "user",
    )
    .map((i) => textOf(i.content));

const turnStatuses = (events: HarnessEvent[]) =>
  events
    .filter(isKernelEvent)
    .filter((e) => e.type === "turn.status")
    .map((e) => (e.type === "turn.status" ? e.status : ""));

function setup(steps: FakeStep[], plugin?: Partial<Plugin>, existingStore?: InMemoryStore) {
  const store = existingStore ?? new InMemoryStore(counterIdGenerator(), fixedClock());
  const host = new PluginHost([
    {
      id: "fake",
      providers: () => [new FakeProvider(steps)],
      tools: () => [new EchoTool()],
      ...plugin,
    },
  ]);
  const engine = new Engine(store, host);
  const events: HarnessEvent[] = [];
  engine.subscribe({ onEvent: (e) => events.push(e) });
  return { store, engine, events };
}

describe("Engine — turn cycle", () => {
  it("runs a tool-shaped turn end to end", async () => {
    const { store, engine, events } = setup([
      toolStep("call1", "echo", { x: 1 }),
      textStep("done"),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    expect(items.map((i) => i.type)).toEqual(["message", "tool_call", "tool_result", "message"]);
    const [result] = toolResults(items);
    expect(result?.status).toBe("ok");
    expect(result?.content).toEqual([{ type: "text", text: JSON.stringify({ x: 1 }) }]);

    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual([
      "turn.status",
      "message",
      "tool_call.started",
      "tool_call.completed",
      "text_delta",
      "message",
      "turn.status",
    ]);
  });

  it("appends exactly one tool_result per tool_call", async () => {
    const twoCalls: FakeStep = [
      { type: "tool_call", callId: "c1", name: "echo", args: { a: 1 } },
      { type: "tool_call", callId: "c2", name: "echo", args: { b: 2 } },
      { type: "completed", content: [], usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const { store, engine } = setup([twoCalls, textStep("ok")]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const calls = toolCalls(items);
    const results = toolResults(items);
    expect(results.length).toBe(calls.length);
    for (const call of calls) {
      expect(results.filter((r) => r.callId === call.callId)).toHaveLength(1);
    }
  });

  it("round-trips a provider reasoning payload onto its item", async () => {
    const { store, engine } = setup([
      textStep("hi", {
        provider: "fake",
        model: "fake-1",
        type: "reasoning",
        version: 1,
        payload: { enc: "x" },
      }),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const assistant = items.find((i) => i.type === "message" && i.role === "assistant");
    expect(assistant).toBeDefined();
    const payloads = await store.getProviderPayloads([assistant!.id]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.itemId).toBe(assistant!.id);
    expect(payloads[0]?.payload).toEqual({ enc: "x" });
  });

  it("re-attaches a stored payload onto its item in the next turn's build", async () => {
    const provider = new RecordingProvider([
      textStep("hi", {
        provider: "fake",
        model: "fake-1",
        type: "reasoning",
        version: 1,
        payload: { enc: "x" },
      }),
      textStep("bye"),
    ]);
    const { store, engine } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);
    await engine.deliver(conv.id, userInput("second"));
    await engine.whenIdle(conv.id);

    // The second turn's build carries the first turn's assistant payload, paired to its item.
    const assistant = provider.requests[1]!.items.find(
      (i) => i.item.type === "message" && i.item.role === "assistant",
    );
    expect(assistant?.payload?.payload).toEqual({ enc: "x" });
  });

  it("stores a reasoning item with its summary, opaque payload, and stream events", async () => {
    const reasoningPayload = {
      provider: "fake",
      model: "fake-1",
      type: "reasoning",
      version: 1,
      payload: { encryptedContent: "BLOB" },
    };
    const { store, engine, events } = setup([
      reasoningStep("thinking it through", { payload: reasoningPayload }),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const reasoning = items.find((i) => i.type === "reasoning");
    if (reasoning?.type !== "reasoning") throw new Error("expected a reasoning item");
    expect(textOf(reasoning.content)).toBe("thinking it through");

    // The opaque blob round-trips, bound to the reasoning item itself.
    const payloads = await store.getProviderPayloads([reasoning.id]);
    expect(payloads[0]?.payload).toEqual({ encryptedContent: "BLOB" });

    // Reasoning streams (delta) and commits (item) like ordinary output.
    expect(events.filter(isKernelEvent).map((e) => e.type)).toContain("reasoning_delta");
    expect(events.filter(isKernelEvent).map((e) => e.type)).toContain("reasoning");
  });

  it("preserves emission order: reasoning → text → call", async () => {
    const { store, engine } = setup([
      interleavedStep([
        { reasoning: "ponder" },
        "answer: ",
        { callId: "c1", name: "echo", args: {} },
      ]),
      textStep("done"),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    expect(shapeOf(items)).toEqual([
      "user:hello",
      "reasoning:ponder",
      "assistant:answer: ",
      "call:c1",
      "result:c1",
      "assistant:done",
    ]);
  });

  it("binds a per-item payload carried on a tool_call", async () => {
    const callPayload = {
      provider: "fake",
      model: "fake-1",
      type: "tool_call",
      version: 1,
      payload: { sig: "S" },
    };
    const { store, engine } = setup([
      interleavedStep([{ callId: "c1", name: "echo", args: {}, payload: callPayload }]),
      textStep("done"),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const call = items.find((i) => i.type === "tool_call");
    const payloads = await store.getProviderPayloads([call!.id]);
    expect(payloads[0]?.payload).toEqual({ sig: "S" });
  });
});

describe("Engine — delivery seam", () => {
  it("runs two rapid sends as two turns, in order", async () => {
    const { store, engine, events } = setup([textStep("one"), textStep("two")]);
    const conv = await store.createConversation({ config: CONFIG });

    // Deliver twice without awaiting idle between: the second lands in the
    // inbox and runs after the first — never as a second concurrent turn.
    await Promise.all([
      engine.deliver(conv.id, userInput("first")),
      engine.deliver(conv.id, userInput("second")),
    ]);
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    expect(userTexts(items)).toEqual(["first", "second"]);

    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(2);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });

  it("forwards a plugin event emitted by a tool onto the stream", async () => {
    const emitTool: Tool = {
      name: "emit",
      description: "emits a note",
      input: { kind: "function", schema: z.unknown() },
      async execute(_args, ctx) {
        ctx.emit({ type: "demo.note", text: "from tool" });
        return { forModel: [{ type: "text", text: "ok" }], status: "ok" };
      },
    };
    const { store, engine, events } = setup([toolStep("c1", "emit", {}), textStep("done")], {
      tools: () => [emitTool],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const plugin = events.find((e) => !isKernelEvent(e));
    expect(plugin).toMatchObject({ type: "demo.note", text: "from tool" });
  });

  it("marks the turn failed when the provider stream is malformed", async () => {
    const { store, engine, events } = setup([[{ type: "text_delta", text: "oops" }]]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("x"));
    await engine.whenIdle(conv.id);

    const failed = events
      .filter(isKernelEvent)
      .find((e) => e.type === "turn.status" && e.status === "failed");
    expect(failed?.type).toBe("turn.status");
    const error = failed?.type === "turn.status" ? failed.error : undefined;
    expect(error).toMatch(/without a 'completed'/);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });

  it("starts a turn from plugin-sourced input", async () => {
    const { store, engine, events } = setup([textStep("hi")]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, {
      source: { kind: "plugin", pluginId: "demo" },
      content: [{ type: "text", text: "ping" }],
    });
    await engine.whenIdle(conv.id);

    expect(userTexts(await store.listItems(conv.id))).toEqual(["ping"]);
    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(1);
  });

  it("runs input that arrives during a live turn as the next turn", async () => {
    const gate = new GateTool();
    const { store, engine, events } = setup(
      [toolStep("c1", "gate", {}), textStep("a"), textStep("b")],
      {
        tools: () => [gate],
      },
    );
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("first"));
    await gate.started;
    await engine.deliver(conv.id, userInput("second")); // arrives while busy → next turn
    gate.release();
    await engine.whenIdle(conv.id);

    expect(userTexts(await store.listItems(conv.id))).toEqual(["first", "second"]);
    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(2);
  });
});

describe("Engine — interleaving order", () => {
  it("writes interleaved text and calls in emission order", async () => {
    const { store, engine } = setup([
      interleavedStep([
        "text1",
        { callId: "A", name: "echo", args: { a: 1 } },
        "text2",
        { callId: "B", name: "echo", args: { b: 2 } },
      ]),
      textStep("done"),
    ]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // Content in emission order; both results land after the assistant content run.
    expect(shapeOf(await store.listItems(conv.id))).toEqual([
      "user:go",
      "assistant:text1",
      "call:A",
      "assistant:text2",
      "call:B",
      "result:A",
      "result:B",
      "assistant:done",
    ]);
  });
});

describe("Engine — steering and queueing", () => {
  it("flushes pending steers into the running turn after a tool result", async () => {
    const gate = new GateTool();
    const { store, engine } = setup([toolStep("c1", "gate", {}), textStep("done")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, userInput("steer1"), "steer");
    await engine.deliver(conv.id, userInput("steer2"), "steer");
    gate.release();
    await engine.whenIdle(conv.id);

    // Both steers land after the tool result, in order, before the next step.
    expect(shapeOf(await store.listItems(conv.id))).toEqual([
      "user:go",
      "call:c1",
      "result:c1",
      "user:steer1",
      "user:steer2",
      "assistant:done",
    ]);
  });

  it("batches input queued during a turn into one next turn", async () => {
    const gate = new GateTool();
    const { store, engine, events } = setup(
      [toolStep("c1", "gate", {}), textStep("done"), textStep("done2")],
      { tools: () => [gate] },
    );
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, userInput("queued1"), "queue");
    await engine.deliver(conv.id, userInput("queued2"), "queue");
    await engine.deliver(conv.id, userInput("steerX"), "steer");
    gate.release();
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const userMsgs = items.filter(
      (i): i is Extract<Item, { type: "message" }> => i.type === "message" && i.role === "user",
    );
    const byText = (t: string) => userMsgs.find((m) => textOf(m.content) === t)!;

    // The steer flushed into turn 1 (same turn as the "go" seed).
    expect(byText("steerX").turnId).toBe(byText("go").turnId);
    // The two queued messages seed ONE later turn together.
    expect(byText("queued1").turnId).toBe(byText("queued2").turnId);
    expect(byText("queued1").turnId).not.toBe(byText("go").turnId);
    // Exactly two turns ran (not three).
    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(2);
  });
});

describe("Engine — interrupt", () => {
  it("interrupts an in-flight tool, stays legal, runs the interrupt content next", async () => {
    const gate = new GateTool(); // ignores the signal — must be abandoned
    const { store, engine, events } = setup([toolStep("c1", "gate", {}), textStep("after")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, userInput("do this instead"), "interrupt");
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    // The abandoned call still has a (synthetic interrupted) result.
    const result = toolResults(items).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    // Every call is answered — transcript stays prompt-legal.
    const answered = new Set(toolResults(items).map((r) => r.callId));
    expect(toolCalls(items).every((c) => answered.has(c.callId))).toBe(true);
    // Turn 1 aborted; the interrupt content ran as turn 2 (completed).
    expect(turnStatuses(events)).toContain("aborted");
    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(1);
    expect(userTexts(items)).toContain("do this instead");
    gate.release(); // release the abandoned tool to avoid a dangling promise
  });

  it("records un-executed parallel calls with interrupted results on abort", async () => {
    const gate = new GateTool({ name: "gate" });
    const parallel: FakeStep = [
      { type: "tool_call", callId: "A", name: "gate", args: {} },
      { type: "tool_call", callId: "B", name: "echo", args: {} },
      { type: "tool_call", callId: "C", name: "echo", args: {} },
      { type: "completed", content: [], usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const { store, engine, events } = setup([parallel, textStep("after")], {
      tools: () => [gate, new EchoTool()],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started; // A is executing; B and C not yet dispatched
    await engine.deliver(conv.id, userInput("redo"), "interrupt");
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    // All three calls are present and answered — none dropped.
    expect(
      toolCalls(items)
        .map((c) => c.callId)
        .sort(),
    ).toEqual(["A", "B", "C"]);
    expect(
      toolResults(items)
        .map((r) => r.callId)
        .sort(),
    ).toEqual(["A", "B", "C"]);
    expect(toolResults(items).every((r) => r.status === "error")).toBe(true);
    expect(turnStatuses(events)).toContain("aborted");
    gate.release();
  });

  it("cancels the stream and saves the partial assistant text", async () => {
    const provider = new GateProvider("hel");
    const { store, engine, events } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await provider.started; // "hel" streamed; provider now blocking before completed
    await engine.deliver(conv.id, noContent, "interrupt");
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const assistant = items.find((i) => i.type === "message" && i.role === "assistant");
    expect(assistant && assistant.type === "message" ? textOf(assistant.content) : "").toBe("hel");
    expect(toolCalls(items)).toHaveLength(0); // nothing dangling
    expect(turnStatuses(events)).toContain("aborted");
  });

  it("cancels a cooperative tool promptly on interrupt", async () => {
    const gate = new GateTool({ honorSignal: true });
    const { store, engine, events } = setup([toolStep("c1", "gate", {}), textStep("after")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, noContent, "interrupt");
    await engine.whenIdle(conv.id); // resolves only if the cooperative tool stopped

    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    expect(turnStatuses(events)).toContain("aborted");
  });

  it("pure interrupt aborts with no follow-up turn", async () => {
    const gate = new GateTool();
    const { store, engine, events } = setup([toolStep("c1", "gate", {}), textStep("after")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, noContent, "interrupt");
    await engine.whenIdle(conv.id);

    const statuses = turnStatuses(events);
    expect(statuses.filter((s) => s === "running")).toHaveLength(1); // only ever one turn
    expect(statuses).toContain("aborted");
    expect(statuses).not.toContain("completed");
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
    gate.release();
  });
});

/** A tool that records whether it ran — to assert a middleware did or didn't reach it. */
const makeProbe = (): { tool: Tool; state: { ran: boolean } } => {
  const state = { ran: false };
  const tool: Tool = {
    name: "probe",
    description: "records execution",
    input: { kind: "function", schema: z.unknown() },
    async execute() {
      state.ran = true;
      return { forModel: [{ type: "text", text: "ran" }], status: "ok" };
    },
  };
  return { tool, state };
};

describe("Engine — tool middleware", () => {
  it("runs middlewares outermost-first and wraps the result on the way out", async () => {
    const order: string[] = [];
    const trace = (id: string): ToolMiddleware => ({
      id,
      async wrap(call, _ctx, next) {
        order.push(`${id}:in`);
        const result = await next(call);
        order.push(`${id}:out`);
        return result;
      },
    });
    const { store, engine } = setup([toolStep("c1", "echo", { x: 1 }), textStep("done")], {
      toolMiddleware: () => [trace("a"), trace("b")],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // First registered is outermost: runs first inbound, last outbound.
    expect(order).toEqual(["a:in", "b:in", "b:out", "a:out"]);
  });

  it("lets a gating middleware deny without executing the tool", async () => {
    const { tool: probe, state } = makeProbe();
    const deny: ToolMiddleware = {
      id: "deny",
      async wrap() {
        return { forModel: [{ type: "text", text: "denied" }], status: "error" };
      },
    };
    const { store, engine } = setup([toolStep("c1", "probe", {}), textStep("done")], {
      tools: () => [probe],
      toolMiddleware: () => [deny],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    expect(textOf(result?.content ?? [])).toBe("denied");
    expect(state.ran).toBe(false);
  });

  it("lets a middleware call next more than once (retry)", async () => {
    let attempts = 0;
    const flaky: Tool = {
      name: "flaky",
      description: "fails once",
      input: { kind: "function", schema: z.unknown() },
      async execute() {
        attempts++;
        return {
          forModel: [{ type: "text", text: String(attempts) }],
          status: attempts < 2 ? "error" : "ok",
        };
      },
    };
    const retry: ToolMiddleware = {
      id: "retry",
      async wrap(call, _ctx, next) {
        const first = await next(call);
        return first.status === "error" ? next(call) : first;
      },
    };
    const { store, engine } = setup([toolStep("c1", "flaky", {}), textStep("done")], {
      tools: () => [flaky],
      toolMiddleware: () => [retry],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(attempts).toBe(2);
    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("ok");
    expect(textOf(result?.content ?? [])).toBe("2");
  });
});

/** Resolves with the first `request.created` raised on the engine's stream. */
const firstRequest = (engine: Engine): Promise<{ requestId: string; request: unknown }> =>
  new Promise((resolve) => {
    const unsubscribe = engine.subscribe({
      onEvent: (e) => {
        if (isKernelEvent(e) && e.type === "request.created") {
          unsubscribe();
          resolve({ requestId: e.requestId, request: e.request });
        }
      },
    });
  });

describe("Engine — request/respond", () => {
  it("round-trips an approval: request.created → respond(allow) → tool runs", async () => {
    const { store, engine, events } = setup([toolStep("c1", "echo", { x: 1 }), textStep("done")], {
      toolMiddleware: () => [approvalMiddleware((call) => call.name === "echo")],
    });
    const conv = await store.createConversation({ config: CONFIG });
    const pending = firstRequest(engine);
    await engine.deliver(conv.id, userInput("go"));

    const { requestId, request } = await pending;
    expect(request).toMatchObject({ kind: "approval", call: { name: "echo" } });
    engine.respond(conv.id, requestId, { decision: "allow" });
    await engine.whenIdle(conv.id);

    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("ok");
    expect(result?.content).toEqual([{ type: "text", text: JSON.stringify({ x: 1 }) }]);
    const types = events.filter(isKernelEvent).map((e) => e.type);
    expect(types).toContain("request.created");
    expect(types).toContain("request.resolved");
  });

  it("denies via approval: respond(deny) yields an error result, tool not run", async () => {
    const { tool: probe, state } = makeProbe();
    const { store, engine } = setup([toolStep("c1", "probe", {}), textStep("done")], {
      tools: () => [probe],
      toolMiddleware: () => [approvalMiddleware(() => true)],
    });
    const conv = await store.createConversation({ config: CONFIG });
    const pending = firstRequest(engine);
    await engine.deliver(conv.id, userInput("go"));

    const { requestId } = await pending;
    engine.respond(conv.id, requestId, { decision: "deny" });
    await engine.whenIdle(conv.id);

    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    expect(textOf(result?.content ?? [])).toContain("denied by approval");
    expect(state.ran).toBe(false);
  });

  it("interrupting a parked request settles it (no leak) with an interrupted result", async () => {
    const { store, engine, events } = setup([toolStep("c1", "echo", {}), textStep("after")], {
      toolMiddleware: () => [approvalMiddleware(() => true)],
    });
    const conv = await store.createConversation({ config: CONFIG });
    const pending = firstRequest(engine);
    await engine.deliver(conv.id, userInput("go"));
    await pending;

    // Interrupt while the middleware is parked. If the parked promise leaked,
    // whenIdle would never resolve — so reaching here at all proves it settled.
    await engine.deliver(conv.id, noContent, "interrupt");
    await engine.whenIdle(conv.id);

    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    expect(turnStatuses(events)).toContain("aborted");
    // Abort cancels via rejection, so the request never "resolves".
    expect(events.filter(isKernelEvent).map((e) => e.type)).not.toContain("request.resolved");

    // A late respond for the cancelled request is a harmless no-op.
    expect(() => engine.respond(conv.id, "req_1", { decision: "allow" })).not.toThrow();
  });
});

/** Wraps a FakeProvider, recording the ModelRequest each step is asked to stream. */
class RecordingProvider implements ModelProvider {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  readonly #inner: FakeProvider;

  constructor(steps: FakeStep[]) {
    this.#inner = new FakeProvider(steps);
  }

  capabilities() {
    return this.#inner.capabilities();
  }

  validateConfig(): void {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield* this.#inner.stream();
  }
}

describe("Engine — rewind", () => {
  it("rewinds to an earlier item; the next turn branches off the abandoned tail", async () => {
    const provider = new RecordingProvider([textStep("one"), textStep("two"), textStep("three")]);
    const { store, engine } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation({ config: CONFIG });

    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);
    const afterTurn1 = await store.listActiveItems(conv.id);
    const rewindTarget = afterTurn1[afterTurn1.length - 1]!; // assistant "one"

    await engine.deliver(conv.id, userInput("second"));
    await engine.whenIdle(conv.id);

    await engine.rewind(conv.id, rewindTarget.id);
    await engine.deliver(conv.id, userInput("third"));
    await engine.whenIdle(conv.id);

    // The active chain branched off turn 1: the turn-2 items are gone from context,
    // but the raw log still retains them.
    expect(userTexts(await store.listActiveItems(conv.id))).toEqual(["first", "third"]);
    expect(userTexts(await store.listItems(conv.id))).toEqual(["first", "second", "third"]);

    // The post-rewind request never saw the abandoned branch.
    const lastRequest = provider.requests.at(-1)!;
    expect(userTexts(lastRequest.items.map((i) => i.item))).toEqual(["first", "third"]);
  });

  it("refuses to rewind while a turn is running", async () => {
    const gate = new GateTool();
    const { store, engine } = setup([toolStep("c1", "gate", {}), textStep("done")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;

    const [userMsg] = await store.listActiveItems(conv.id);
    await expect(engine.rewind(conv.id, userMsg!.id)).rejects.toThrow(/running/);

    gate.release();
    await engine.whenIdle(conv.id);
  });
});

const compactions = (items: Item[]) =>
  items.filter((i): i is Extract<Item, { type: "compaction" }> => i.type === "compaction");

describe("Engine — compaction", () => {
  it("folds the context at the boundary and bounds later builds at the summary", async () => {
    const provider = new RecordingProvider([
      textStep("one"),
      textStep("two"),
      textStep("three"),
      textStep("four"),
    ]);
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 3 }) }),
    });
    const conv = await store.createConversation({ config: CONFIG });

    for (const text of ["first", "second", "third", "fourth"]) {
      await engine.deliver(conv.id, userInput(text));
      await engine.whenIdle(conv.id);
    }

    // Exactly one fold (the window first exceeded 3 on turn 3), and an event for it.
    const folds = compactions(await store.listItems(conv.id));
    expect(folds.map((f) => textOf(f.content))).toEqual(["summary of 5 items"]);
    expect(events.filter((e) => e.type === "compaction")).toHaveLength(1);

    // The build right after the fold starts at the summary alone.
    expect(shapeOf(provider.requests[2]!.items.map((i) => i.item))).toEqual([
      "compaction:summary of 5 items",
    ]);
    // The next turn's window is [summary, ...newer] and never re-folds.
    expect(shapeOf(provider.requests[3]!.items.map((i) => i.item))).toEqual([
      "compaction:summary of 5 items",
      "assistant:three",
      "user:fourth",
    ]);

    // The raw log keeps the full pre-compaction history.
    expect(userTexts(await store.listItems(conv.id))).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("un-compacts on rewind past the summary, restoring full history in the build", async () => {
    const provider = new RecordingProvider([
      textStep("A"),
      textStep("B"),
      textStep("C"),
      textStep("D"),
    ]);
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 4 }) }),
    });
    const conv = await store.createConversation({ config: CONFIG });

    await engine.deliver(conv.id, userInput("a"));
    await engine.whenIdle(conv.id);
    const afterTurn1 = await store.listActiveItems(conv.id);
    const rewindTarget = afterTurn1[afterTurn1.length - 1]!; // assistant "A"

    for (const text of ["b", "c"]) {
      await engine.deliver(conv.id, userInput(text));
      await engine.whenIdle(conv.id);
    }
    expect(compactions(await store.listActiveItems(conv.id))).toHaveLength(1);

    await engine.rewind(conv.id, rewindTarget.id);
    await engine.deliver(conv.id, userInput("d"));
    await engine.whenIdle(conv.id);

    // The post-rewind branch excludes the abandoned summary; the build sees the
    // pre-compaction history verbatim again.
    const lastBuild = provider.requests.at(-1)!.items.map((i) => i.item);
    expect(compactions(lastBuild)).toHaveLength(0);
    expect(userTexts(lastBuild)).toEqual(["a", "d"]);
    // The summary still lives in the raw log, on the abandoned branch.
    expect(compactions(await store.listItems(conv.id))).toHaveLength(1);
  });
});

describe("reconcileConversation", () => {
  it("closes a dangling tool_call and fails the turn", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const conv = await store.createConversation({ config: CONFIG });
    const turn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: turn.id,
      type: "tool_call",
      callId: "x",
      name: "echo",
      args: {},
    });

    await reconcileConversation(store, conv.id);

    const items = await store.listItems(conv.id);
    const [result] = toolResults(items);
    expect(result?.callId).toBe("x");
    expect(result?.status).toBe("error");
    // transcript is prompt-legal: no tool_call without a result
    const answered = new Set(toolResults(items).map((r) => r.callId));
    expect(toolCalls(items).every((c) => answered.has(c.callId))).toBe(true);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });
});

describe("Engine — crash reconciliation on load", () => {
  it("un-wedges a crashed conversation on first touch and continues", async () => {
    // Simulate a crash: a turn left `running` with a dangling tool_call (no result).
    // Without on-load reconcile, the stale `running` turn makes `createTurn` throw
    // forever — the conversation is permanently wedged.
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const conv = await store.createConversation({ config: CONFIG });
    const stale = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: stale.id,
      type: "tool_call",
      callId: "stuck",
      name: "echo",
      args: {},
    });

    // A fresh Engine over the same store (a new process reopening the conversation).
    const { engine, events } = setup([textStep("recovered")], undefined, store);
    await engine.deliver(conv.id, userInput("resume"));
    await engine.whenIdle(conv.id);

    // The dangling call is closed with the synthetic error result, the stale turn is
    // gone (failed), and a brand-new turn ran to completion on top of the repaired log.
    const items = await store.listItems(conv.id);
    const [result] = toolResults(items);
    expect(result?.callId).toBe("stuck");
    expect(result?.status).toBe("error");
    expect(textOf(result?.content ?? [])).toBe("interrupted: session ended");
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
    expect(turnStatuses(events)).toContain("completed");
    expect(shapeOf(items)).toEqual([
      "call:stuck",
      "result:stuck",
      "user:resume",
      "assistant:recovered",
    ]);
  });

  it("is a no-op on a clean conversation", async () => {
    const { store, engine, events } = setup([textStep("hi")]);
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    // Reconcile must not synthesize results or fail the live turn on a clean log.
    const items = await store.listItems(conv.id);
    expect(toolResults(items)).toHaveLength(0);
    expect(turnStatuses(events)).toEqual(["running", "completed"]);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });
});

/** Records the model of every request it serves, so a test can see what each turn used. */
class CatalogProvider implements ModelProvider {
  readonly provider = "rec";
  readonly seen: string[] = [];
  capabilities() {
    return { contentTypes: ["text"], toolCalling: false, editFormat: "string_replace" as const };
  }
  validateConfig(): void {}
  listModels() {
    return [
      { provider: "rec", model: "m1" },
      { provider: "rec", model: "m2" },
    ];
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.seen.push(request.modelConfig.model);
    yield {
      type: "completed",
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function recordingSetup() {
  const provider = new CatalogProvider();
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const engine = new Engine(store, new PluginHost([{ id: "rec", providers: () => [provider] }]));
  const events: HarnessEvent[] = [];
  engine.subscribe({ onEvent: (e) => events.push(e) });
  return { provider, store, engine, events };
}

const recConfig = { instructions: "", model: { provider: "rec", model: "m1" } };

/** Injects a keyed context item the first time `echo` is called; dedups by scanning
 *  the active window. */
const injectorMw = (key: string, text: string): ToolMiddleware => ({
  id: "injector",
  async wrap(call, ctx, next) {
    const result = await next(call);
    if (call.name === "echo") {
      const present = (await ctx.active()).some((i) => i.type === "context" && i.key === key);
      if (!present) await ctx.appendContext(key, [{ type: "text", text }]);
    }
    return result;
  },
});

describe("Engine — context injection", () => {
  it("injects a keyed context item once across repeated triggering calls", async () => {
    const { store, engine } = setup(
      [toolStep("c1", "echo", {}), toolStep("c2", "echo", {}), textStep("done")],
      { toolMiddleware: () => [injectorMw("ctx", "RULES")] },
    );
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // One context item, appended after its triggering tool_call and before that result.
    expect(shapeOf(await store.listActiveItems(conv.id))).toEqual([
      "user:go",
      "call:c1",
      "context:ctx",
      "result:c1",
      "call:c2",
      "result:c2",
      "assistant:done",
    ]);
  });

  it("re-injects context after a rewind drops it from the active chain", async () => {
    const { store, engine } = setup(
      [toolStep("c1", "echo", {}), textStep("done"), toolStep("c2", "echo", {}), textStep("done2")],
      { toolMiddleware: () => [injectorMw("ctx", "RULES")] },
    );
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const userMsg = (await store.listItems(conv.id)).find(
      (i) => i.type === "message" && i.role === "user",
    )!;
    await engine.rewind(conv.id, userMsg.id);

    await engine.deliver(conv.id, userInput("go2"));
    await engine.whenIdle(conv.id);

    const ctxOf = (items: Item[]) => items.filter((i) => i.type === "context");
    // The active chain carries exactly one context item (the re-injected one).
    expect(ctxOf(await store.listActiveItems(conv.id))).toHaveLength(1);
    // The raw log retains both the abandoned and the re-injected copy.
    expect(ctxOf(await store.listItems(conv.id))).toHaveLength(2);
  });
});

describe("Engine — model middleware", () => {
  it("passes the stream through unchanged when a middleware just forwards", async () => {
    const passthrough: ModelMiddleware = { id: "pass", wrap: (req, _ctx, next) => next(req) };
    const { store, engine } = setup([textStep("hi")], { modelMiddleware: () => [passthrough] });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("yo"));
    await engine.whenIdle(conv.id);
    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:yo", "assistant:hi"]);
  });

  it("lets a retry middleware re-issue a step that failed before the first event", async () => {
    let calls = 0;
    const flaky: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        editFormat: "string_replace",
      }),
      validateConfig: () => {},
      async *stream() {
        if (++calls === 1) throw new Error("transient");
        yield* textStep("recovered");
      },
    };
    const retry: ModelMiddleware = {
      id: "retry",
      async *wrap(req, _ctx, next) {
        for (let attempt = 0; ; attempt++) {
          try {
            yield* next(req);
            return;
          } catch (err) {
            if (attempt >= 1) throw err;
          }
        }
      },
    };
    const { store, engine, events } = setup([], {
      providers: () => [flaky],
      modelMiddleware: () => [retry],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);
    expect(calls).toBe(2);
    expect(turnStatuses(events)).toEqual(["running", "completed"]);
    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:go", "assistant:recovered"]);
  });

  it("lets a middleware short-circuit without calling the provider", async () => {
    let providerCalled = false;
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        editFormat: "string_replace",
      }),
      validateConfig: () => {},
      async *stream() {
        providerCalled = true;
        yield* textStep("");
      },
    };
    const canned: ModelMiddleware = {
      id: "canned",
      async *wrap() {
        yield* textStep("canned");
      },
    };
    const { store, engine } = setup([], {
      providers: () => [provider],
      modelMiddleware: () => [canned],
    });
    const conv = await store.createConversation({ config: CONFIG });
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);
    expect(providerCalled).toBe(false);
    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:go", "assistant:canned"]);
  });
});

describe("Engine — model switching", () => {
  it("setModel persists the new model and emits config.changed", async () => {
    const { store, engine, events } = recordingSetup();
    const conv = await store.createConversation({ config: recConfig });

    await engine.setModel(conv.id, { provider: "rec", model: "m2" });

    expect((await store.getConversation(conv.id))?.config.model).toEqual({
      provider: "rec",
      model: "m2",
    });
    expect(events.filter(isKernelEvent).filter((e) => e.type === "config.changed")).toEqual([
      { type: "config.changed", conversationId: conv.id, model: { provider: "rec", model: "m2" } },
    ]);
  });

  it("availableModels aggregates the registered providers' catalogs", () => {
    const { engine } = recordingSetup();
    expect(engine.availableModels()).toEqual([
      { provider: "rec", model: "m1" },
      { provider: "rec", model: "m2" },
    ]);
  });

  it("reads the model fresh per turn, so a switch between turns lands on the next turn", async () => {
    const { provider, store, engine } = recordingSetup();
    const conv = await store.createConversation({ config: recConfig });

    await engine.deliver(conv.id, userInput("one"));
    await engine.whenIdle(conv.id);
    await engine.setModel(conv.id, { provider: "rec", model: "m2" });
    await engine.deliver(conv.id, userInput("two"));
    await engine.whenIdle(conv.id);

    expect(provider.seen).toEqual(["m1", "m2"]);
  });
});
