import { describe, expect, it } from "vitest";
import { isKernelEvent } from "@harness/protocol";
import type { DeliveryInput, HarnessEvent, Item, Plugin, Tool } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import {
  counterIdGenerator,
  EchoTool,
  FakeProvider,
  type FakeStep,
  fixedClock,
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

const toolCalls = (items: Item[]) =>
  items.filter((i): i is Extract<Item, { type: "tool_call" }> => i.type === "tool_call");
const toolResults = (items: Item[]) =>
  items.filter((i): i is Extract<Item, { type: "tool_result" }> => i.type === "tool_result");

function setup(steps: FakeStep[], plugin?: Partial<Plugin>) {
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
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
});

describe("Engine — delivery seam", () => {
  it("runs two rapid sends as two turns, in order", async () => {
    const { store, engine, events } = setup([textStep("one"), textStep("two")]);
    const conv = await store.createConversation({ config: CONFIG });

    // Deliver twice without awaiting idle between: the second lands in the
    // mailbox and runs after the first — never as a second concurrent turn.
    await Promise.all([
      engine.deliver(conv.id, userInput("first")),
      engine.deliver(conv.id, userInput("second")),
    ]);
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const userTexts = items
      .filter(
        (i): i is Extract<Item, { type: "message" }> => i.type === "message" && i.role === "user",
      )
      .flatMap((i) => i.content.map((b) => (b.type === "text" ? b.text : "")));
    expect(userTexts).toEqual(["first", "second"]);

    const completed = events
      .filter(isKernelEvent)
      .filter((e) => e.type === "turn.status" && e.status === "completed");
    expect(completed).toHaveLength(2);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });

  it("forwards a plugin event emitted by a tool onto the stream", async () => {
    const emitTool: Tool = {
      name: "emit",
      schema: { name: "emit", description: "emits a note", parameters: { type: "object" } },
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
