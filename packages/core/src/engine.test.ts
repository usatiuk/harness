import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  addUsage,
  ContextWindowExceededError,
  conversationOf,
  isKernelEvent,
} from "@harness/protocol";
import type {
  ContentBlock,
  DeliveryInput,
  HarnessEvent,
  Item,
  ModelConfig,
  ModelIdentityChange,
  ModelMiddleware,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ToolMiddlewareContext,
  RequestMiddlewareContext,
  NewContextBuild,
  Plugin,
  Tool,
  ToolMiddleware,
  Usage,
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
  newConversationInput,
  reasoningStep,
  testConfigResolver,
  textStep,
  toolStep,
} from "@harness/testkit";
import { PluginHost } from "./plugin-host.ts";
import { Engine } from "./engine.ts";
import { okResult } from "@harness/protocol";
import { reconcileConversation } from "./reconcile.ts";
import { compactedWindow, fallbackCompaction, modelCompaction } from "./policies.ts";

const CONFIG = {
  instructions: "be helpful",
  model: { provider: "fake", model: "fake-1" },
};

it("a failed first load does not become a parent but registered children retain their root", async () => {
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const engine = new Engine(store, new PluginHost([]), testConfigResolver());
  const missing = "missing" as import("@harness/protocol").ConversationId;
  const child = "child" as import("@harness/protocol").ConversationId;
  await expect(engine.prepare(missing)).rejects.toThrow("unknown conversation");
  expect(() => engine.registerChild(missing, child)).toThrow("inactive parent");
  const root = await store.createConversation(newConversationInput(CONFIG));
  await engine.prepare(root.id);
  engine.registerChild(root.id, child);
  await expect(engine.prepare(child)).rejects.toThrow("unknown conversation");
  expect(engine.rootConversationOf(child)).toBe(root.id);
  await engine.deactivate(root.id, { force: true });
});

it("refreshes defaults captured by an activation still loading", async () => {
  const store = new InMemoryStore();
  const record = await store.createConversation({ workspaceRoot: null, overrides: {} });
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let enabled = true;
  let initialLoad = true;
  const engine = new Engine(
    store,
    new PluginHost([{ id: "fake", providers: () => [new FakeProvider([])] }]),
    async () => {
      const config = { ...CONFIG, plugins: { policy: { enabled } } };
      if (initialLoad) {
        initialLoad = false;
        markStarted();
        await gate;
      }
      return config;
    },
  );
  const preparing = engine.prepare(record.id);
  await started;
  enabled = false;
  const refreshing = engine.refreshPluginDefaults(["policy"]);
  release();
  await Promise.all([preparing, refreshing]);
  expect(engine.configFor(record.id)?.plugins?.policy).toEqual({ enabled: false });
});

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
    if (i.type === "provider_output") return `provider:${textOf(i.content)}`;
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
  const engine = new Engine(store, host, testConfigResolver());
  const events: HarnessEvent[] = [];
  engine.subscribe({ onEvent: (e) => events.push(e) });
  return { store, engine, events };
}

describe("Engine — turn cycle", () => {
  it("rejects a second completion without executing calls or overwriting first accounting", async () => {
    let executions = 0;
    const firstUsage = { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 };
    const { store, engine, events } = setup(
      [
        [
          { type: "tool_call", callId: "call", name: "echo", args: {} },
          { type: "completed", usage: firstUsage, error: "first terminal failure" },
          { type: "completed", usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } },
        ],
      ],
      {
        tools: () => [
          {
            name: "echo",
            description: "echo",
            input: { kind: "function", schema: z.object({}) },
            async execute() {
              executions++;
              return okResult("executed");
            },
          },
        ],
      },
    );
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await engine.whenIdle(conversation.id);
    expect(executions).toBe(0);
    expect(turnStatuses(events)).toEqual(["running", "failed"]);
    expect(toolResults(await store.listItems(conversation.id))).toMatchObject([
      { callId: "call", status: "error" },
    ]);
    expect((await store.listModelUsage(conversation.id)).map((row) => row.usage)).toEqual([
      firstUsage,
    ]);
  });

  it("pairs a recorded local call with interruption when its provider throws on abort", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let executed = false;
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        fileTools: "string_replace",
      }),
      validateConfig: () => {},
      listModels: () => [],
      async *stream(_request, signal) {
        yield { type: "tool_call", callId: "call", name: "echo", args: {} };
        entered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
    };
    const tool: Tool = {
      name: "echo",
      description: "echo",
      input: { kind: "function", schema: z.object({}) },
      async execute() {
        executed = true;
        return okResult("ran");
      },
    };
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      tools: () => [tool],
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await started;
    await engine.deliver(conversation.id, noContent, "interrupt");
    await engine.whenIdle(conversation.id);
    expect(executed).toBe(false);
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
    expect(toolResults(await store.listItems(conversation.id))).toMatchObject([
      {
        callId: "call",
        status: "error",
        content: [{ type: "text", text: "interrupted: turn aborted by new input" }],
      },
    ]);
  });

  it("persists display-only search hints without replay or extra model steps across reload, switching and compaction", async () => {
    const provider = Object.assign(
      new RecordingProvider([
        [
          { type: "text_delta", text: "preview", phase: "commentary" },
          { type: "provider_output", content: [{ type: "text", text: "Searched SECRET" }] },
          { type: "message", content: [{ type: "text", text: "finalized" }], phase: "commentary" },
          { type: "completed", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 } },
        ],
        textStep("next"),
        textStep("summary"),
      ]),
      { providerOptions: Object.freeze({ webSearch: true }) },
    );
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await engine.whenIdle(conversation.id);
    expect(provider.requests).toHaveLength(1);
    expect(turnStatuses(events)).toEqual(["running", "completed"]);
    const items = await store.listItems(conversation.id);
    expect(shapeOf(items)).toEqual(["user:go", "provider:Searched SECRET", "assistant:finalized"]);
    expect(items.at(-1)).toMatchObject({ phase: "commentary" });
    const hint = items.find((item) => item.type === "provider_output")!;
    expect(await store.getProviderPayloads([hint.id])).toEqual([]);
    expect(
      textOf(
        fallbackCompaction({
          conversationId: conversation.id,
          purpose: "agent",
          instructions: [],
          tools: [],
          items: items.map((item) => ({ item })),
        }),
      ),
    ).not.toContain("SECRET");
    await engine.deactivate(conversation.id);
    await engine.prepare(conversation.id);
    await engine.setModel(conversation.id, { provider: "fake", model: "fake-2" });
    await engine.deliver(conversation.id, userInput("again"));
    await engine.whenIdle(conversation.id);
    await expect(engine.compact(conversation.id)).resolves.toBe("compacted");
    expect(provider.requests).toHaveLength(3);
    for (const request of provider.requests) {
      expect(request.items.some(({ item }) => item.type === "provider_output")).toBe(false);
      expect(JSON.stringify(request)).not.toContain("SECRET");
      expect(request.providerOptions).toEqual({ webSearch: true });
    }
    expect(provider.requests.at(-1)?.toolChoice).toBe("none");
    for (const row of await store.listModelUsage(conversation.id)) {
      expect((await store.getContextBuild(row.contextBuildId!))?.providerOptions).toEqual({
        webSearch: true,
      });
    }
  });

  it("drains received finalized output and accounting after cancellation without executing tools", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let executed = false;
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        fileTools: "string_replace",
      }),
      validateConfig: () => {},
      listModels: () => [],
      async *stream(_request, signal) {
        yield { type: "text_delta", text: "preview A" };
        entered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "message", content: [{ type: "text", text: "A" }] };
        yield { type: "message", content: [{ type: "text", text: "B" }] };
        yield { type: "tool_call", callId: "call", name: "echo", args: {} };
        yield {
          type: "completed",
          usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
        };
      },
    };
    const tool: Tool = {
      name: "echo",
      description: "echo",
      input: { kind: "function", schema: z.object({}) },
      async execute() {
        executed = true;
        return okResult("ran");
      },
    };
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      tools: () => [tool],
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await started;
    await engine.deliver(conversation.id, noContent, "interrupt");
    await engine.whenIdle(conversation.id);
    expect(executed).toBe(false);
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
    const items = await store.listItems(conversation.id);
    expect(
      items
        .filter((item) => item.type === "message" && item.role === "assistant")
        .map((item) => textOf(item.content)),
    ).toEqual(["A", "B"]);
    expect(toolResults(items)).toMatchObject([
      {
        callId: "call",
        status: "error",
        content: [{ type: "text", text: "interrupted: turn aborted by new input" }],
      },
    ]);
    expect(await store.listModelUsage(conversation.id)).toMatchObject([
      { usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("fails unfinished native search once without trying to resume it", async () => {
    const provider = new RecordingProvider([
      [
        { type: "provider_output", content: [{ type: "text", text: "Searching the web…" }] },
        {
          type: "completed",
          usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
          error: "native search incomplete",
        },
      ],
    ]);
    const { store, engine, events } = setup([], { providers: () => [provider] });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await engine.whenIdle(conversation.id);
    expect(provider.requests).toHaveLength(1);
    expect(turnStatuses(events)).toEqual(["running", "failed"]);
    expect(await store.listModelUsage(conversation.id)).toMatchObject([
      { usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(
      await store.getProviderPayloads(
        (await store.listItems(conversation.id)).map((item) => item.id),
      ),
    ).toEqual([]);
  });

  it("keeps generic request history compacted by default and follows rewind when including older items", async () => {
    const snapshots: { current: readonly Item[]; full: readonly Item[] }[] = [];
    const { store, engine } = setup(
      [
        toolStep("first-request", "echo", {}),
        textStep("done"),
        toolStep("second-request", "echo", {}),
        textStep("done"),
      ],
      {
        toolMiddleware: () => [
          {
            id: "interaction",
            wrap: async (call, ctx, next) => {
              await ctx.request({ kind: "history-inspection" });
              return next(call);
            },
          },
        ],
        requestMiddleware: () => [
          {
            id: "inspect",
            wrap: async (_request, ctx) => {
              snapshots.push({
                current: await ctx.active(),
                full: await ctx.active({ includeCompacted: true }),
              });
              return {};
            },
          },
        ],
      },
    );
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    const turn = await store.createTurn(conversation.id);
    await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "old history" }],
    });
    const firstFold = await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "compaction",
      content: [{ type: "text", text: "first summary" }],
    });
    const secondFold = await store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "compaction",
      content: [{ type: "text", text: "second summary" }],
    });
    await store.updateTurn(turn.id, "completed");
    await engine.deliver(conversation.id, userInput("inspect"));
    await engine.whenIdle(conversation.id);
    expect(snapshots[0]!.current[0]!.id).toBe(secondFold.id);
    expect(snapshots[0]!.full.map((item) => item.type)).toEqual([
      "message",
      "compaction",
      "compaction",
      "message",
      "tool_call",
    ]);
    await engine.rewind(conversation.id, firstFold.id);
    await engine.deliver(conversation.id, userInput("inspect selected branch"));
    await engine.whenIdle(conversation.id);
    expect(snapshots[1]!.current[0]!.id).toBe(firstFold.id);
    expect(snapshots[1]!.full.map((item) => item.type)).toEqual([
      "message",
      "compaction",
      "message",
      "tool_call",
    ]);
    expect(snapshots[1]!.full.some((item) => item.id === secondFold.id)).toBe(false);
    expect(JSON.stringify(snapshots[1]!.full)).not.toContain("first-request");
  });

  it("records forced context-assembly teardown as cancellation without constructing services", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let constructed = false;
    const { store, engine, events } = setup([textStep("unused")], {
      services: () => [
        {
          key: "owned",
          for: () => {
            constructed = true;
            return {};
          },
        },
      ],
      contextSources: () => [
        {
          id: "gated-context",
          instructions: async (ctx) => {
            entered();
            await gate;
            ctx.service("owned");
            return [];
          },
        },
      ],
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("go"));
    await waiting;
    const closing = engine.deactivate(conversation.id, { force: true });
    release();
    await closing;
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
    expect(constructed).toBe(false);
    expect(engine.conversationTreeState(conversation.id)).toEqual([]);
  });

  it("validates model config before capability-dependent tool construction", async () => {
    let capabilitiesCalled = false;
    const provider: ModelProvider = {
      provider: "fake",
      validateConfig: () => {
        throw new Error("invalid model selection");
      },
      capabilities: () => {
        capabilitiesCalled = true;
        return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" };
      },
      listModels: () => [],
      stream() {
        throw new Error("unreachable");
      },
    };
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const engine = new Engine(
      store,
      new PluginHost([{ id: "fake", providers: () => [provider] }]),
      testConfigResolver(),
    );
    const events: HarnessEvent[] = [];
    engine.subscribe({ onEvent: (event) => events.push(event) });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);
    expect(capabilitiesCalled).toBe(false);
    expect(turnStatuses(events)).toContain("failed");
  });

  it("refuses idle-required deactivation while the root turn is running", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const provider = new GateProvider("partial");
    const engine = new Engine(
      store,
      new PluginHost([{ id: "fake", providers: () => [provider] }]),
      testConfigResolver(),
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("hello"));
    await provider.started;
    await expect(engine.deactivate(conv.id)).resolves.toEqual({ status: "busy" });

    provider.release();
    await engine.whenIdle(conv.id);
    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:hello", "assistant:partial"]);
  });

  it("force-deactivates a running conversation tree and discards queued input", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const provider = new GateProvider("partial");
    const engine = new Engine(
      store,
      new PluginHost([{ id: "fake", providers: () => [provider] }]),
      testConfigResolver(),
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("first"));
    await provider.started;
    await engine.deliver(conv.id, userInput("queued"), "queue");
    await expect(engine.deactivate(conv.id, { force: true })).resolves.toEqual({
      status: "deactivated",
    });

    expect(userTexts(await store.listItems(conv.id))).toEqual(["first"]);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
  });

  it("requires force to deactivate a conversation tree with a running descendant", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const provider = new GateProvider("child partial");
    const engine = new Engine(
      store,
      new PluginHost([{ id: "fake", providers: () => [provider] }]),
      testConfigResolver(),
    );
    const root = await store.createConversation(newConversationInput(CONFIG));
    const child = await store.createConversation(newConversationInput(CONFIG));
    await engine.prepare(root.id);
    engine.registerChild(root.id, child.id);
    await engine.deliver(child.id, userInput("work"));
    await provider.started;

    await expect(engine.deactivate(root.id)).resolves.toEqual({ status: "busy" });
    await expect(engine.deactivate(root.id, { force: true })).resolves.toEqual({
      status: "deactivated",
    });

    expect(await store.getActiveTurn(child.id)).toBeUndefined();
  });

  it("uses plugin blockers only for graceful refusal and leaves cleanup to dispose", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const state = { blocked: true, disposed: false };
    const engine = new Engine(
      store,
      new PluginHost([
        {
          id: "lifecycle",
          providers: () => [new FakeProvider([])],
          services: () => [
            {
              key: "owned",
              for: () => state,
              blocksDeactivation: (service) => (service as typeof state).blocked,
              dispose: (service) => {
                (service as typeof state).disposed = true;
              },
            },
          ],
        },
      ]),
      testConfigResolver(),
    );
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.prepare(conversation.id);
    expect(engine.serviceFor(conversation.id, "owned")).toBe(state);

    await expect(engine.deactivate(conversation.id)).resolves.toEqual({ status: "busy" });
    expect(state.disposed).toBe(false);

    state.blocked = false;
    await expect(engine.deactivate(conversation.id)).resolves.toEqual({ status: "deactivated" });
    expect(state.disposed).toBe(true);
  });

  it("rejects user input but drops stale plugin notices while teardown is in progress", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    let release!: () => void;
    let started!: () => void;
    const disposing = new Promise<void>((resolve) => (release = resolve));
    const disposalStarted = new Promise<void>((resolve) => (started = resolve));
    const engine = new Engine(
      store,
      new PluginHost([
        {
          id: "fake",
          providers: () => [new FakeProvider([])],
          services: () => [
            {
              key: "execution",
              for: () => ({}),
              dispose: async () => {
                started();
                await disposing;
              },
            },
          ],
        },
      ]),
      testConfigResolver(),
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.prepare(conv.id);

    const closing = engine.deactivate(conv.id);
    await disposalStarted;
    await expect(engine.deliver(conv.id, userInput("late"))).rejects.toThrow(
      "cannot deliver input during conversation deactivation",
    );
    await expect(
      engine.deliver(conv.id, {
        source: { kind: "plugin", pluginId: "activity" },
        content: [{ type: "text", text: "done" }],
      }),
    ).resolves.toBeUndefined();
    release();
    await expect(closing).resolves.toEqual({ status: "deactivated" });
  });

  it("ignores callbacks from a disposed activation after the same root reopens", async () => {
    let oldContext!: ToolMiddlewareContext;
    let oldRequestContext!: RequestMiddlewareContext;
    const { engine, store, events } = setup(
      [
        toolStep("capture", "capture", {}),
        textStep("first completed"),
        textStep("reopened completed"),
      ],
      {
        toolMiddleware: () => [
          {
            id: "capture-context",
            wrap: async (call, ctx, next) => {
              oldContext = ctx;
              await ctx.request({ kind: "audit.capture" });
              return next(call);
            },
          },
        ],
        requestMiddleware: () => [
          {
            id: "capture-request",
            wrap: async (_request, ctx) => {
              oldRequestContext = ctx;
              return {};
            },
          },
        ],
        tools: () => [
          {
            name: "capture",
            description: "capture context",
            input: { kind: "function", schema: z.strictObject({}) },
            execute: async () => {
              return okResult("captured");
            },
          },
        ],
      },
    );
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("first"));
    await engine.whenIdle(conversation.id);
    await engine.deactivate(conversation.id);
    await engine.prepare(conversation.id);
    oldContext.deliver([{ type: "text", text: "stale completion" }]);
    oldContext.emit({ type: "audit.stale" });
    oldRequestContext.emit({ type: "audit.stale-request" });
    await expect(oldContext.request({ kind: "audit.stale-request" })).rejects.toThrow(
      "inactive runtime",
    );
    await engine.deliver(conversation.id, userInput("reopened"));
    await engine.whenIdle(conversation.id);
    expect(userTexts(await store.listActiveItems(conversation.id))).toEqual(["first", "reopened"]);
    expect(events.some((event) => event.type === "audit.stale")).toBe(false);
    expect(events.some((event) => event.type === "audit.stale-request")).toBe(false);
  });

  it("closes one root while another foreground turn remains running", async () => {
    const a = new GateProvider("A"),
      b = new GateProvider("B");
    const store = new InMemoryStore();
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => a.capabilities(),
      validateConfig: () => {},
      listModels: () => [],
      stream: (request, signal) =>
        (request.modelConfig.model === "a" ? a : b).stream(request, signal),
    };
    const engine = new Engine(
      store,
      new PluginHost([{ id: "fake", providers: () => [provider] }]),
      testConfigResolver(),
    );
    const first = await store.createConversation(
      newConversationInput({ ...CONFIG, model: { provider: "fake", model: "a" } }),
    );
    const second = await store.createConversation(
      newConversationInput({ ...CONFIG, model: { provider: "fake", model: "b" } }),
    );
    await Promise.all([
      engine.deliver(first.id, userInput("A input")),
      engine.deliver(second.id, userInput("B input")),
    ]);
    await Promise.all([a.started, b.started]);
    await engine.deactivate(first.id, { force: true });
    expect(engine.conversationTreeState(second.id)[0]?.status).toBe("running");
    b.release();
    await engine.whenIdle(second.id);
    expect(shapeOf(await store.listActiveItems(second.id))).toEqual([
      "user:B input",
      "assistant:B",
    ]);
    await engine.deactivate(second.id);
  });

  it("deactivates one root without disturbing another loaded root", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const disposed: string[] = [];
    const engine = new Engine(
      store,
      new PluginHost([
        {
          id: "fake",
          providers: () => [new FakeProvider([textStep("still running")])],
          services: () => [
            {
              key: "owned",
              for: (conversation) => ({ conversationId: conversation.id }),
              dispose: (service) => {
                disposed.push((service as { conversationId: string }).conversationId);
              },
            },
          ],
        },
      ]),
      testConfigResolver(),
    );
    const first = await store.createConversation(newConversationInput(CONFIG));
    const second = await store.createConversation(newConversationInput(CONFIG));
    await engine.prepare(first.id);
    await engine.prepare(second.id);
    const firstService = engine.serviceFor(first.id, "owned");
    const secondService = engine.serviceFor(second.id, "owned");

    await expect(engine.deactivate(first.id)).resolves.toEqual({ status: "deactivated" });
    expect(disposed).toEqual([first.id]);
    expect(engine.serviceFor(first.id, "owned")).toBeUndefined();
    expect(engine.serviceFor(second.id, "owned")).toBe(secondService);
    expect(secondService).not.toBe(firstService);

    await engine.deliver(second.id, userInput("continue"));
    await engine.whenIdle(second.id);
    expect(shapeOf(await store.listActiveItems(second.id))).toEqual([
      "user:continue",
      "assistant:still running",
    ]);
  });

  it("runs a tool-shaped turn end to end", async () => {
    const { store, engine, events } = setup([
      toolStep("call1", "echo", { x: 1 }),
      textStep("done"),
    ]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    expect(items.map((i) => i.type)).toEqual(["message", "tool_call", "tool_result", "message"]);
    const [result] = toolResults(items);
    expect(result?.status).toBe("ok");
    expect(result?.content).toEqual([{ type: "text", text: JSON.stringify({ x: 1 }) }]);

    expect(await store.getActiveTurn(conv.id)).toBeUndefined();
    expect(events.map((e) => e.type).filter((t) => t !== "inbox")).toEqual([
      "turn.status",
      "item.appended",
      "item.appended",
      "usage.changed",
      "item.appended",
      "text_delta",
      "item.appended",
      "usage.changed",
      "usage.changed",
      "turn.status",
    ]);
  });

  it("appends exactly one tool_result per tool_call", async () => {
    const twoCalls: FakeStep = [
      { type: "tool_call", callId: "c1", name: "echo", args: { a: 1 } },
      { type: "tool_call", callId: "c2", name: "echo", args: { b: 2 } },
      {
        type: "completed",
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
      },
    ];
    const { store, engine } = setup([twoCalls, textStep("ok")]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    expect(
      events.some(
        (event) =>
          isKernelEvent(event) && event.type === "item.appended" && event.item.type === "reasoning",
      ),
    ).toBe(true);
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("hello"));
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    const call = items.find((i) => i.type === "tool_call");
    const payloads = await store.getProviderPayloads([call!.id]);
    expect(payloads[0]?.payload).toEqual({ sig: "S" });
  });
});

describe("Engine — delivery seam", () => {
  it("rejects a failed recency write before admitting or executing the input", async () => {
    const { store, engine, events } = setup([]);
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    vi.spyOn(store, "recordUserInput").mockImplementation(() => {
      throw new Error("recency write failed");
    });
    await expect(engine.deliver(conversation.id, userInput("hello"))).rejects.toThrow(
      "recency write failed",
    );
    await engine.whenIdle(conversation.id);
    expect(await store.listItems(conversation.id)).toEqual([]);
    expect(turnStatuses(events)).toEqual([]);
    expect((await store.getConversation(conversation.id))?.lastUsedAt).toBe(conversation.createdAt);
  });

  it("changes recency only for nonempty user input, including queued input", async () => {
    const provider = new GateProvider("done");
    const { store, engine } = setup([], { providers: () => [provider] });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.prepare(conversation.id);
    expect((await store.getConversation(conversation.id))?.lastUsedAt).toBe(conversation.createdAt);
    await engine.deliver(conversation.id, userInput("first"));
    const first = (await store.getConversation(conversation.id))!.lastUsedAt;
    await engine.deliver(conversation.id, userInput("queued"), "queue");
    const queued = (await store.getConversation(conversation.id))!.lastUsedAt;
    expect(queued).toBeGreaterThan(first);
    await engine.deliver(
      conversation.id,
      {
        source: { kind: "plugin", pluginId: "activity" },
        content: [{ type: "text", text: "completed" }],
      },
      "queue",
    );
    expect((await store.getConversation(conversation.id))?.lastUsedAt).toBe(queued);
    await engine.deliver(conversation.id, { source: { kind: "user" }, content: [] }, "interrupt");
    provider.release();
    await engine.whenIdle(conversation.id);
    expect((await store.getConversation(conversation.id))?.lastUsedAt).toBe(queued);
  });

  it("runs two rapid sends as two turns, in order", async () => {
    const { store, engine, events } = setup([textStep("one"), textStep("two")]);
    const conv = await store.createConversation(newConversationInput(CONFIG));

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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const plugin = events.find((e) => !isKernelEvent(e));
    expect(plugin).toMatchObject({ type: "demo.note", text: "from tool" });
  });

  it("marks the turn failed when the provider stream is malformed", async () => {
    const { store, engine, events } = setup([[{ type: "text_delta", text: "oops" }]]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await gate.started;
    await engine.deliver(conv.id, userInput("second")); // arrives while busy → next turn
    gate.release();
    await engine.whenIdle(conv.id);

    expect(userTexts(await store.listItems(conv.id))).toEqual(["first", "second"]);
    expect(turnStatuses(events).filter((s) => s === "completed")).toHaveLength(2);
  });
});

describe("Engine — scoped subscription", () => {
  it("delivers only the scoped conversation's events; an unscoped observer sees all", async () => {
    const { store, engine } = setup([textStep("a"), textStep("b")]);
    const convA = await store.createConversation(newConversationInput(CONFIG));
    const convB = await store.createConversation(newConversationInput(CONFIG));

    const all: HarnessEvent[] = [];
    const onlyA: HarnessEvent[] = [];
    engine.subscribe({ onEvent: (e) => all.push(e) });
    engine.subscribe({ onEvent: (e) => onlyA.push(e) }, convA.id);

    await engine.deliver(convA.id, userInput("hi A"));
    await engine.whenIdle(convA.id);
    await engine.deliver(convB.id, userInput("hi B"));
    await engine.whenIdle(convB.id);

    // The scoped observer saw A's events and none of B's.
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((e) => conversationOf(e) === convA.id)).toBe(true);
    // The unscoped observer saw both conversations.
    expect(all.some((e) => conversationOf(e) === convA.id)).toBe(true);
    expect(all.some((e) => conversationOf(e) === convB.id)).toBe(true);
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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

  it("emits an inbox snapshot reflecting pending input, empty once drained", async () => {
    const gate = new GateTool();
    const { store, engine, events } = setup([toolStep("c1", "gate", {}), textStep("done")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    await engine.deliver(conv.id, userInput("queued"), "queue");
    const inboxes = (): { intent: string; text: string }[][] =>
      events
        .filter((e) => e.type === "inbox")
        .map((e) => (e as unknown as { pending: { intent: string; text: string }[] }).pending);
    // A queue-while-busy snapshot carries the pending entry.
    expect(inboxes().some((p) => p.some((d) => d.text === "queued" && d.intent === "queue"))).toBe(
      true,
    );
    // A plain `send` is never surfaced as pending — only queue/steer are.
    expect(inboxes().every((p) => p.every((d) => d.intent !== "send"))).toBe(true);
    gate.release();
    await engine.whenIdle(conv.id);
    // The last snapshot is empty: everything drained into turns.
    expect(inboxes().at(-1)).toEqual([]);
  });
});

describe("Engine — interrupt", () => {
  it("interrupts an in-flight tool, stays legal, runs the interrupt content next", async () => {
    const gate = new GateTool(); // ignores the signal — must be abandoned
    const { store, engine, events } = setup([toolStep("c1", "gate", {}), textStep("after")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
      {
        type: "completed",
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
      },
    ];
    const { store, engine, events } = setup([parallel, textStep("after")], {
      tools: () => [gate, new EchoTool()],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(attempts).toBe(2);
    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("ok");
    expect(textOf(result?.content ?? [])).toBe("2");
  });
});

describe("Engine — tool scope", () => {
  it("withholds tools outside config.tools.allow and rejects a call to one as unknown", async () => {
    const { store, engine } = setup([toolStep("c1", "echo", {}), textStep("done")]);
    const conv = await store.createConversation(
      newConversationInput({ ...CONFIG, tools: { allow: ["read"] } }),
    );
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // `echo` is contributed but withheld by the allow-list, so its call gets the unknown-tool result.
    const result = toolResults(await store.listItems(conv.id)).find((r) => r.callId === "c1");
    expect(result?.status).toBe("error");
    expect(textOf(result?.content ?? [])).toBe("unknown tool: echo");
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    expect(events.filter(isKernelEvent).map((e) => e.type)).toContain("request.resolved");

    // A late respond for the cancelled request is a harmless no-op.
    expect(() => engine.respond(conv.id, "req_1", { decision: "allow" })).not.toThrow();
  });
});

/** Wraps a FakeProvider, recording the ModelRequest each step is asked to stream. */
class RecordingProvider implements ModelProvider {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  readonly #inner: FakeProvider;

  constructor(
    steps: FakeStep[],
    private readonly limits?: {
      contextWindow?: number;
      maxOutputTokens?: number;
      maxInputTokens?: number;
    },
  ) {
    this.#inner = new FakeProvider(steps);
  }

  capabilities() {
    return this.#inner.capabilities();
  }

  validateConfig(): void {}

  listModels() {
    return this.limits
      ? [{ provider: "fake", model: "fake-1", ...this.limits }]
      : this.#inner.listModels();
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield* this.#inner.stream();
  }
}

/** Rejects requests that cannot fit their input and requested output in one response window. */
class CapacityProvider implements ModelProvider {
  readonly provider = "fake";
  readonly requests: ModelRequest[] = [];
  readonly budgets: Array<{ input: number; output: number }> = [];
  #cursor = 0;

  capabilities() {
    return { contentTypes: ["text"], toolCalling: true, fileTools: "string_replace" as const };
  }

  validateConfig(): void {}

  listModels() {
    return [{ provider: "fake", model: "fake-1", contextWindow: 10_000, maxOutputTokens: 2_000 }];
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const input = this.#cursor === 0 ? 7_900 : request.prompt ? 8_000 : 100;
    const output = request.maxOutputTokens ?? 2_000;
    this.budgets.push({ input, output });
    if (input + output > 10_000) throw new ContextWindowExceededError();
    const step =
      this.#cursor++ === 0
        ? textStep("one", undefined, { inputTokens: input, outputTokens: 1, cachedReadTokens: 0 })
        : this.#cursor === 2
          ? textStep("capacity summary", undefined, {
              inputTokens: input,
              outputTokens: 1,
              cachedReadTokens: 0,
            })
          : textStep("done");
    for (const event of step) yield event;
  }
}

describe("Engine — rewind", () => {
  it("rewinds to an earlier item; the next turn branches off the abandoned tail", async () => {
    const provider = new RecordingProvider([textStep("one"), textStep("two"), textStep("three")]);
    const { store, engine } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation(newConversationInput(CONFIG));

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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
  it.each([{}, { contextWindow: 10000 }, { maxInputTokens: 8000 }, { maxOutputTokens: 1000 }])(
    "does not invent an automatic threshold from incomplete capacity %j",
    async (limits) => {
      const provider = new RecordingProvider([textStep("one"), textStep("two")], limits);
      const { engine, store } = setup([], {
        providers: () => [provider],
        policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
      });
      const conv = await store.createConversation(newConversationInput(CONFIG));
      await engine.deliver(conv.id, userInput("first"));
      await engine.whenIdle(conv.id);
      await engine.deliver(conv.id, userInput("second"));
      await engine.whenIdle(conv.id);
      expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
      await engine.compact(conv.id);
      expect(compactions(await store.listItems(conv.id))).toHaveLength(1);
    },
  );
  it("compacts immediately when the output reserve leaves no positive input allowance", async () => {
    const provider = new RecordingProvider([textStep("done")], {
      maxInputTokens: 1000,
      maxOutputTokens: 2000,
      contextWindow: 5000,
    });
    const { engine, store } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 0 }) }),
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("run"));
    await engine.whenIdle(conversation.id);
    expect(compactions(await store.listItems(conversation.id))).toHaveLength(1);
    expect(provider.requests[0]!.items.map(({ item }) => item.type)).toEqual(["compaction"]);
  });
  it.each([{}, { contextWindow: 10000 }, { maxInputTokens: 8000 }, { maxOutputTokens: 1000 }])(
    "honors an explicit threshold with incomplete capacity metadata %j",
    async (limits) => {
      const provider = new RecordingProvider(
        [
          textStep("one", undefined, { inputTokens: 2000, outputTokens: 1, cachedReadTokens: 0 }),
          textStep("two"),
        ],
        limits,
      );
      const { engine, store } = setup([], {
        providers: () => [provider],
        policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
      });
      const conversation = await store.createConversation(
        newConversationInput({ ...CONFIG, compaction: { thresholdTokens: 1500 } }),
      );
      await engine.deliver(conversation.id, userInput("first"));
      await engine.whenIdle(conversation.id);
      await engine.deliver(conversation.id, userInput("second"));
      await engine.whenIdle(conversation.id);
      expect(compactions(await store.listItems(conversation.id))).toHaveLength(1);
      expect(provider.requests[1]!.items[0]!.item.type).toBe("compaction");
    },
  );
  it.each([
    { input: 6200, maxInput: 8000, configured: undefined, folds: 0 },
    { input: 6500, maxInput: 8000, configured: undefined, folds: 0 },
    { input: 7000, maxInput: 8000, configured: undefined, folds: 1 },
    { input: 6200, maxInput: 8000, configured: 6000, folds: 1 },
    { input: 6200, maxInput: 8000, configured: 20000, folds: 0 },
    { input: 8000, maxInput: undefined, configured: undefined, folds: 1 },
    { input: 7500, maxInput: 20000, configured: undefined, folds: 0 },
    { input: 8200, maxInput: 20000, configured: undefined, folds: 1 },
    { input: 9000, maxInput: 20000, configured: undefined, folds: 1 },
  ])(
    "compacts at the effective threshold for $input input tokens, max $maxInput, configured $configured",
    async ({ input, maxInput, configured, folds }) => {
      const provider = new RecordingProvider(
        [
          textStep("one", undefined, {
            inputTokens: input,
            outputTokens: 1,
            cachedReadTokens: Math.floor(input / 2),
          }),
          textStep("two"),
        ],
        {
          contextWindow: 10000,
          maxOutputTokens: 1000,
          ...(maxInput === undefined ? {} : { maxInputTokens: maxInput }),
        },
      );
      const { engine, store } = setup([], {
        providers: () => [provider],
        policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
      });
      const conv = await store.createConversation(
        newConversationInput({
          ...CONFIG,
          ...(configured === undefined ? {} : { compaction: { thresholdTokens: configured } }),
        }),
      );
      await engine.deliver(conv.id, userInput("first"));
      await engine.whenIdle(conv.id);
      await engine.deliver(conv.id, userInput("second"));
      await engine.whenIdle(conv.id);
      expect(compactions(await store.listItems(conv.id))).toHaveLength(folds);
    },
  );
  it("automatically compacts using independent input/output limits without a context window", async () => {
    const provider = new RecordingProvider(
      [
        textStep("one", undefined, { inputTokens: 7000, outputTokens: 1, cachedReadTokens: 0 }),
        textStep("two"),
      ],
      { maxInputTokens: 8000, maxOutputTokens: 1000 },
    );
    const { engine, store } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("first"));
    await engine.whenIdle(conversation.id);
    await engine.deliver(conversation.id, userInput("second"));
    await engine.whenIdle(conversation.id);
    expect(compactions(await store.listItems(conversation.id))).toHaveLength(1);
  });
  it.each([
    { bytes: 20, folds: 0 },
    { bytes: 12000, folds: 1 },
  ])(
    "counts $bytes bytes of appended tool output against the checkpoint",
    async ({ bytes, folds }) => {
      const provider = new RecordingProvider(
        [
          toolStep(
            "call",
            "echo",
            {},
            { inputTokens: 1000, outputTokens: 1, cachedReadTokens: 500 },
          ),
          textStep("done"),
        ],
        { contextWindow: 10000, maxOutputTokens: 1000 },
      );
      const tool = new EchoTool();
      vi.spyOn(tool, "execute").mockResolvedValue(okResult("x".repeat(bytes)));
      const { engine, store } = setup([], {
        providers: () => [provider],
        tools: () => [tool],
        policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
      });
      const conversation = await store.createConversation(
        newConversationInput({ ...CONFIG, compaction: { thresholdTokens: 3000 } }),
      );
      await engine.deliver(conversation.id, userInput("run"));
      await engine.whenIdle(conversation.id);
      expect(provider.requests).toHaveLength(2);
      expect(compactions(await store.listItems(conversation.id))).toHaveLength(folds);
    },
  );

  it("compacts twice between tool steps in one turn without capacity metadata", async () => {
    const usage = { inputTokens: 1000, outputTokens: 1, cachedReadTokens: 0 };
    const provider = new RecordingProvider([
      toolStep("first", "echo", {}, usage),
      toolStep("second", "echo", {}, usage),
      textStep("done"),
    ]);
    const tool = new EchoTool();
    vi.spyOn(tool, "execute").mockResolvedValue(okResult("x".repeat(12000)));
    const { engine, store } = setup([], {
      providers: () => [provider],
      tools: () => [tool],
      policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
    });
    const conversation = await store.createConversation(
      newConversationInput({ ...CONFIG, compaction: { thresholdTokens: 3000 } }),
    );
    await engine.deliver(conversation.id, userInput("run"));
    await engine.whenIdle(conversation.id);
    expect(compactions(await store.listItems(conversation.id))).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(
      provider.requests.slice(1).map((request) => request.items.map(({ item }) => item.type)),
    ).toEqual([["compaction"], ["compaction"]]);
  });

  it("does not reuse a context checkpoint from another model", async () => {
    const limits = { contextWindow: 10000, maxOutputTokens: 2000 };
    const provider = new RecordingProvider(
      [
        textStep("first", undefined, { inputTokens: 7900, outputTokens: 1, cachedReadTokens: 0 }),
        textStep("next"),
      ],
      limits,
    );
    vi.spyOn(provider, "listModels").mockReturnValue([
      { provider: "fake", model: "fake-1", ...limits },
      { provider: "fake", model: "fake-2", ...limits },
    ]);
    const { engine, store } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 1 }) }),
    });
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conversation.id, userInput("first"));
    await engine.whenIdle(conversation.id);
    await engine.setModel(conversation.id, { provider: "fake", model: "fake-2" });
    await engine.deliver(conversation.id, userInput("again"));
    await engine.whenIdle(conversation.id);
    expect(provider.requests.map((request) => request.modelConfig.model)).toEqual([
      "fake-1",
      "fake-2",
    ]);
    expect(compactions(await store.listItems(conversation.id))).toHaveLength(0);
  });

  it.each([
    { reason: "changed provider options", previousSearch: false, inputTokensAreContext: undefined },
    { reason: "cumulative billing input", previousSearch: true, inputTokensAreContext: false },
  ])(
    "does not reuse a context checkpoint after $reason",
    async ({ previousSearch, inputTokensAreContext }) => {
      const limits = { contextWindow: 10_000, maxOutputTokens: 2_000 };
      const first = Object.assign(
        new RecordingProvider(
          [
            [
              { type: "message", content: [{ type: "text", text: "first" }] },
              {
                type: "completed",
                usage: { inputTokens: 7_900, outputTokens: 1, cachedReadTokens: 0 },
                ...(inputTokensAreContext === false ? { inputTokensAreContext: false } : {}),
              },
            ],
          ],
          limits,
        ),
        { providerOptions: Object.freeze({ webSearch: previousSearch }) },
      );
      const initial = setup([], {
        providers: () => [first],
        policies: () => ({ compaction: modelCompaction }),
      });
      const conversation = await initial.store.createConversation(newConversationInput(CONFIG));
      await initial.engine.deliver(conversation.id, userInput("first"));
      await initial.engine.whenIdle(conversation.id);
      await initial.engine.deactivate(conversation.id);
      const next = Object.assign(new RecordingProvider([textStep("next")], limits), {
        providerOptions: Object.freeze({ webSearch: true }),
      });
      const reopened = setup(
        [],
        { providers: () => [next], policies: () => ({ compaction: modelCompaction }) },
        initial.store,
      );
      await reopened.engine.deliver(conversation.id, userInput("again"));
      await reopened.engine.whenIdle(conversation.id);
      expect(turnStatuses(reopened.events)).toEqual(["running", "completed"]);
      expect(next.requests).toHaveLength(1);
      expect(compactions(await initial.store.listItems(conversation.id))).toHaveLength(0);
    },
  );

  it("rejects a second helper completion and retains the first accounting", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 };
    const { store, engine, events } = setup(
      [
        [
          { type: "completed", usage, error: "first terminal failure" },
          { type: "completed", usage: null },
        ],
      ],
      { policies: () => ({ compaction: modelCompaction }) },
    );
    const conversation = await store.createConversation(newConversationInput(CONFIG));
    const seed = await store.createTurn(conversation.id);
    await store.appendItem({
      conversationId: conversation.id,
      turnId: seed.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seed.id, "completed");
    await expect(engine.compact(conversation.id)).rejects.toThrow("after completed");
    expect(turnStatuses(events)).toEqual(["running", "failed"]);
    expect(compactions(await store.listItems(conversation.id))).toHaveLength(0);
    expect((await store.listModelUsage(conversation.id)).map((row) => row.usage)).toEqual([usage]);
  });

  it("folds the context at the boundary and bounds later builds at the summary", async () => {
    const provider = new RecordingProvider(
      [
        textStep("one"),
        textStep("two", undefined, {
          inputTokens: 950,
          outputTokens: 1,
          cachedReadTokens: 0,
        }),
        textStep("three"),
        textStep("four"),
      ],
      { contextWindow: 1_100, maxOutputTokens: 100 },
    );
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 3 }) }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

    for (const text of ["first", "second", "third", "fourth"]) {
      await engine.deliver(conv.id, userInput(text));
      await engine.whenIdle(conv.id);
    }

    // Exactly one fold (the window first exceeded 3 on turn 3), and an event for it.
    const folds = compactions(await store.listItems(conv.id));
    expect(folds.map((f) => textOf(f.content))).toEqual(["summary of 5 items"]);
    expect(
      events.filter(
        (event) =>
          isKernelEvent(event) &&
          event.type === "item.appended" &&
          event.item.type === "compaction",
      ),
    ).toHaveLength(1);

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
    const provider = new RecordingProvider(
      [
        textStep("A"),
        textStep("B", undefined, {
          inputTokens: 950,
          outputTokens: 1,
          cachedReadTokens: 0,
        }),
        textStep("C"),
        textStep("D"),
      ],
      { contextWindow: 1_100, maxOutputTokens: 100 },
    );
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: fakeCompaction({ over: 4 }) }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

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

  it("uses the same request prefix, dispatches compaction tool calls, and continues", async () => {
    const priorPayload = {
      provider: "fake",
      model: "fake-1",
      type: "reasoning",
      version: 1,
      payload: { encrypted: "prior" },
    };
    const compactPayload = {
      provider: "fake",
      model: "fake-1",
      type: "reasoning",
      version: 1,
      payload: { encrypted: "compact" },
    };
    const provider = new RecordingProvider(
      [
        [
          {
            type: "reasoning",
            content: [{ type: "text", text: "prior thought" }],
            payload: priorPayload,
          },
          { type: "text_delta", text: "one" },
          { type: "message", content: [{ type: "text", text: "one" }] },
          {
            type: "completed",
            usage: { inputTokens: 8_000, outputTokens: 10, cachedReadTokens: 0 },
          },
        ],
        [
          {
            type: "reasoning",
            content: [{ type: "text", text: "compact thought" }],
            payload: compactPayload,
          },
          { type: "text_delta", text: "summary" },
          { type: "message", content: [{ type: "text", text: "summary" }] },
          { type: "tool_call", callId: "compact-call", name: "echo", args: { next: true } },
          {
            type: "completed",
            usage: { inputTokens: 1_250, outputTokens: 20, cachedReadTokens: 0 },
          },
        ],
        textStep("done"),
      ],
      { contextWindow: 10_000, maxOutputTokens: 2_000 },
    );
    const middlewarePrompts: Array<string | undefined> = [];
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
      modelMiddleware: () => [
        {
          id: "record-compaction",
          wrap(request, _ctx, next) {
            middlewarePrompts.push(request.prompt);
            return next(request);
          },
        },
      ],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);
    await engine.deliver(conv.id, userInput("second"));
    await engine.whenIdle(conv.id);

    expect(provider.requests).toHaveLength(3);
    expect(middlewarePrompts).toEqual([undefined, expect.stringMatching(/compacting/i), undefined]);
    const [normal, compact, continued] = provider.requests;
    expect(compact!.instructions).toEqual(normal!.instructions);
    expect(compact!.tools).toEqual(normal!.tools);
    expect(compact!.prompt).toMatch(/compacting/i);
    expect(compact!.items.find((entry) => entry.item.type === "reasoning")?.payload).toMatchObject(
      priorPayload,
    );
    expect(shapeOf(continued!.items.map((entry) => entry.item))).toEqual([
      "compaction:summary",
      "reasoning:compact thought",
      "call:compact-call",
      "result:compact-call",
    ]);
    expect(shapeOf(await store.listActiveItems(conv.id)).slice(-5)).toEqual([
      "compaction:summary",
      "reasoning:compact thought",
      "call:compact-call",
      "result:compact-call",
      "assistant:done",
    ]);
    const compactReasoning = (await store.listActiveItems(conv.id)).find(
      (item) => item.type === "reasoning" && textOf(item.content) === "compact thought",
    );
    expect(
      compactReasoning ? await store.getProviderPayloads([compactReasoning.id]) : [],
    ).toHaveLength(1);
  });

  it("manual compaction disables tools, commits only the summary, and does not continue", async () => {
    const provider = new RecordingProvider([
      textStep("one"),
      [
        { type: "reasoning", content: [{ type: "text", text: "summary reasoning" }] },
        ...textStep("manual summary"),
      ],
    ]);
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);

    await expect(engine.compact(conv.id)).resolves.toBe("compacted");

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.toolChoice).toBe("none");
    expect(provider.requests[1]!.maxOutputTokens).toBeUndefined();
    expect(provider.requests[1]!.tools).toEqual(provider.requests[0]!.tools);
    expect(shapeOf(compactedWindow(await store.listActiveItems(conv.id)))).toEqual([
      "compaction:manual summary",
    ]);
  });

  it("manual compaction no-ops on an empty conversation", async () => {
    const { store, engine } = setup([]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await expect(engine.compact(conv.id)).resolves.toBe("noop");
  });

  it("manual compaction rejects while a turn is running", async () => {
    const gate = new GateProvider("working");
    const { store, engine } = setup([], { providers: () => [gate] });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await gate.started;

    await expect(engine.compact(conv.id)).rejects.toThrow(/while a turn is running/);

    gate.release();
    await engine.whenIdle(conv.id);
  });

  it("reserves the runtime before manual compaction performs its first store read", async () => {
    const provider = new RecordingProvider([
      textStep("seeded"),
      textStep("manual summary"),
      textStep("after queued delivery"),
    ]);
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("seed"));
    await engine.whenIdle(conv.id);

    const original = store.listActiveItems.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    store.listActiveItems = async (id) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return original(id);
    };

    const compacting = engine.compact(conv.id);
    await blocked;
    await engine.deliver(conv.id, userInput("queued while compacting"));
    await expect(engine.compact(conv.id)).rejects.toThrow(/while a turn is running/);
    release();

    await expect(compacting).resolves.toBe("compacted");
    await engine.whenIdle(conv.id);
    expect(provider.requests).toHaveLength(3);
    expect(shapeOf(compactedWindow(await store.listActiveItems(conv.id)))).toEqual([
      "compaction:manual summary",
      "user:queued while compacting",
      "assistant:after queued delivery",
    ]);
  });

  it("enforces summary-only manual compaction for custom strategies", async () => {
    const { store, engine, events } = setup([textStep("seeded")], {
      policies: () => ({
        compaction: {
          async compact() {
            return {
              content: [{ type: "text" as const, text: "summary" }],
              outputItems: [
                { type: "tool_call" as const, callId: "forbidden", name: "echo", args: {} },
              ],
            };
          },
        },
      }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("seed"));
    await engine.whenIdle(conv.id);

    await expect(engine.compact(conv.id)).rejects.toThrow(/cannot emit tool calls/);
    expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
    expect(toolCalls(await store.listItems(conv.id))).toHaveLength(0);
    expect(turnStatuses(events).at(-1)).toBe("failed");
  });

  it("marks cancellation during manual model compaction as aborted", async () => {
    const gate = new GateProvider("partial summary");
    const { store, engine, events } = setup([], {
      providers: () => [gate],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    const compacting = engine.compact(conv.id);
    await gate.started;
    await engine.deliver(conv.id, noContent, "interrupt");

    await expect(compacting).rejects.toThrow(/turn aborted/);
    await engine.whenIdle(conv.id);
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
    expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
  });

  it("records unknown usage before a model-backed compaction terminal error", async () => {
    const { store, engine, events } = setup(
      [[{ type: "completed", usage: null, error: "summary truncated" }]],
      { policies: () => ({ compaction: modelCompaction }) },
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    await expect(engine.compact(conv.id)).rejects.toThrow(/summary truncated/);
    expect((await store.listModelUsage(conv.id)).map((row) => row.usage)).toEqual([null]);
    expect(
      events.filter(isKernelEvent).find((event) => event.type === "usage.changed"),
    ).toMatchObject({
      type: "usage.changed",
      summary: { incomplete: true, cost: 0 },
    });
    expect(turnStatuses(events).at(-1)).toBe("failed");
  });

  it("validates an invoker model override before recording its context build", async () => {
    class CountingStore extends InMemoryStore {
      builds = 0;
      override async recordContextBuild(input: NewContextBuild) {
        this.builds += 1;
        return super.recordContextBuild(input);
      }
    }
    const provider: ModelProvider = {
      provider: "fake",
      validateConfig(config) {
        if (config.model !== "fake-1") throw new Error("invalid invoker model");
      },
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        fileTools: "string_replace",
      }),
      listModels: () => [],
      stream() {
        throw new Error("unreachable");
      },
    };
    const store = new CountingStore(counterIdGenerator(), fixedClock());
    const { engine } = setup(
      [],
      {
        providers: () => [provider],
        policies: () => ({
          compaction: {
            async compact(input) {
              await input.models.invoke({
                instructions: [],
                items: [],
                modelConfig: { provider: "fake", model: "missing" },
              });
              return null;
            },
          },
        }),
      },
      store,
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    await expect(engine.compact(conv.id)).rejects.toThrow(/invalid invoker model/);
    expect(store.builds).toBe(0);
  });

  it("fails and closes a manual turn when post-creation context setup throws", async () => {
    let contextReads = 0;
    const { store, engine, events } = setup([textStep("recovered")], {
      contextSources: () => [
        {
          id: "fails-once",
          async instructions() {
            if (contextReads++ === 0) throw new Error("context setup failed");
            return [];
          },
        },
      ],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    await expect(engine.compact(conv.id)).rejects.toThrow(/context setup failed/);
    expect(await store.getActiveTurn(conv.id)).toBeUndefined();

    await engine.deliver(conv.id, userInput("retry normally"));
    await engine.whenIdle(conv.id);
    expect(turnStatuses(events)).toEqual(["running", "failed", "running", "completed"]);
  });

  it("does not commit a fold returned by a signal-ignoring strategy after cancellation", async () => {
    let started!: () => void;
    let release!: () => void;
    const strategyStarted = new Promise<void>((resolve) => (started = resolve));
    const strategyGate = new Promise<void>((resolve) => (release = resolve));
    const { store, engine, events } = setup([], {
      policies: () => ({
        compaction: {
          async compact() {
            started();
            await strategyGate;
            return { content: [{ type: "text" as const, text: "must not commit" }] };
          },
        },
      }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    const compacting = engine.compact(conv.id);
    await strategyStarted;
    await engine.deliver(conv.id, noContent, "interrupt");
    release();

    await expect(compacting).rejects.toThrow(/turn aborted/);
    expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
  });

  it("reports cancellation during context assembly as aborted rather than completed noop", async () => {
    let started!: () => void;
    let release!: () => void;
    const contextStarted = new Promise<void>((resolve) => (started = resolve));
    const contextGate = new Promise<void>((resolve) => (release = resolve));
    const { store, engine, events } = setup([], {
      contextSources: () => [
        {
          id: "gated",
          async instructions() {
            started();
            await contextGate;
            return [];
          },
        },
      ],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    const seedTurn = await store.createTurn(conv.id);
    await store.appendItem({
      conversationId: conv.id,
      turnId: seedTurn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "seed" }],
    });
    await store.updateTurn(seedTurn.id, "completed");

    const compacting = engine.compact(conv.id);
    await contextStarted;
    await engine.deliver(conv.id, noContent, "interrupt");
    release();

    await expect(compacting).rejects.toThrow(/turn aborted/);
    expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
    expect(turnStatuses(events)).toEqual(["running", "aborted"]);
  });

  it("uses a reduced compaction output allowance that fits the declared window", async () => {
    const provider = new CapacityProvider();
    const { store, engine } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);
    await engine.deliver(conv.id, userInput("second"));
    await engine.whenIdle(conv.id);

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]!.prompt).toMatch(/compacting/i);
    expect(provider.requests[1]!.maxOutputTokens).toBeLessThan(2_000);
    expect(provider.budgets.every(({ input, output }) => input + output <= 10_000)).toBe(true);
  });

  it("flushes a steer after a compaction-emitted tool before continuing", async () => {
    const gate = new GateTool();
    const provider = new RecordingProvider(
      [
        textStep("one", undefined, {
          inputTokens: 8_000,
          outputTokens: 1,
          cachedReadTokens: 0,
        }),
        [
          { type: "text_delta", text: "summary" },
          { type: "message", content: [{ type: "text", text: "summary" }] },
          { type: "tool_call", callId: "compact-gate", name: "gate", args: {} },
          {
            type: "completed",
            usage: { inputTokens: 8_100, outputTokens: 1, cachedReadTokens: 0 },
          },
        ],
        textStep("done"),
      ],
      { contextWindow: 10_000, maxOutputTokens: 2_000 },
    );
    const { store, engine } = setup([], {
      providers: () => [provider],
      tools: () => [gate],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);

    await engine.deliver(conv.id, userInput("second"));
    await gate.started;
    await engine.deliver(conv.id, userInput("steer now"), "steer");
    gate.release();
    await engine.whenIdle(conv.id);

    expect(shapeOf(provider.requests[2]!.items.map(({ item }) => item))).toEqual([
      "compaction:summary",
      "call:compact-gate",
      "result:compact-gate",
      "user:steer now",
    ]);
  });

  it("attempts at most one compaction before failing an irreducibly oversized request", async () => {
    let compactionCalls = 0;
    let providerCalls = 0;
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        fileTools: "string_replace",
      }),
      validateConfig: () => undefined,
      listModels: () => [
        { provider: "fake", model: "fake-1", contextWindow: 1_000, maxOutputTokens: 200 },
      ],
      async *stream() {
        providerCalls++;
        yield await Promise.reject(new ContextWindowExceededError());
      },
    };
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      contextSources: () => [
        {
          id: "irreducible",
          async instructions() {
            return [{ type: "text" as const, text: "x".repeat(4_000) }];
          },
        },
      ],
      policies: () => ({
        compaction: {
          async compact() {
            compactionCalls++;
            return { content: [{ type: "text" as const, text: "summary" }] };
          },
        },
      }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(compactionCalls).toBe(1);
    expect(providerCalls).toBe(1);
    expect(compactions(await store.listItems(conv.id))).toHaveLength(1);
    expect(turnStatuses(events)).toEqual(["running", "failed"]);
  });

  it("does not fold active history for an unrelated automatic strategy failure", async () => {
    const provider = new RecordingProvider(
      [
        textStep("one", undefined, {
          inputTokens: 8_000,
          outputTokens: 1,
          cachedReadTokens: 0,
        }),
      ],
      { contextWindow: 10_000, maxOutputTokens: 2_000 },
    );
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      policies: () => ({
        compaction: {
          async compact() {
            throw new Error("authentication failed");
          },
        },
      }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("first"));
    await engine.whenIdle(conv.id);
    const before = await store.listActiveItems(conv.id);

    await engine.deliver(conv.id, userInput("second"));
    await engine.whenIdle(conv.id);

    expect(compactions(await store.listItems(conv.id))).toHaveLength(0);
    expect((await store.listActiveItems(conv.id)).slice(0, before.length)).toEqual(before);
    expect(turnStatuses(events).at(-1)).toBe("failed");
  });

  it.each([false, true])(
    "compacts and retries once after a typed context overflow (hint: %s)",
    async (hint) => {
      const requests: ModelRequest[] = [];
      let cursor = 0;
      const provider: ModelProvider = {
        provider: "fake",
        capabilities: () => ({
          contentTypes: ["text"],
          toolCalling: true,
          fileTools: "string_replace",
        }),
        validateConfig: () => undefined,
        listModels: () => [],
        async *stream(request) {
          requests.push(request);
          if (cursor++ === 0) {
            if (hint)
              yield {
                type: "provider_output",
                content: [{ type: "text", text: "Search activity" }],
              };
            throw new ContextWindowExceededError();
          }
          const step = cursor === 2 ? textStep("overflow summary") : textStep("recovered");
          for (const event of step) yield event;
        },
      };
      const { store, engine, events } = setup([], {
        providers: () => [provider],
        policies: () => ({ compaction: modelCompaction }),
      });
      const conv = await store.createConversation(newConversationInput(CONFIG));

      await engine.deliver(conv.id, userInput("large"));
      await engine.whenIdle(conv.id);

      expect(requests).toHaveLength(3);
      expect(
        requests.every((request) =>
          request.items.every(({ item }) => item.type !== "provider_output"),
        ),
      ).toBe(true);
      expect(requests[1]!.maxOutputTokens).toBeUndefined();
      expect(shapeOf(compactedWindow(await store.listActiveItems(conv.id)))).toEqual([
        "compaction:overflow summary",
        "assistant:recovered",
      ]);
      expect(turnStatuses(events)).toEqual(["running", "completed"]);
    },
  );

  it("materializes a deterministic fallback when the compaction call also overflows", async () => {
    const requests: ModelRequest[] = [];
    let cursor = 0;
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => ({
        contentTypes: ["text"],
        toolCalling: true,
        fileTools: "string_replace",
      }),
      validateConfig: () => undefined,
      listModels: () => [],
      async *stream(request) {
        requests.push(request);
        if (cursor++ < 2) throw new ContextWindowExceededError();
        for (const event of textStep("recovered")) yield event;
      },
    };
    const { store, engine, events } = setup([], {
      providers: () => [provider],
      policies: () => ({ compaction: modelCompaction }),
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("too large for either model call"));
    await engine.whenIdle(conv.id);

    expect(requests).toHaveLength(3);
    const [fold] = compactions(await store.listItems(conv.id));
    expect(fold && textOf(fold.content)).toMatch(/deterministic fallback/);
    expect(shapeOf(compactedWindow(await store.listActiveItems(conv.id))).at(-1)).toBe(
      "assistant:recovered",
    );
    expect(turnStatuses(events)).toEqual(["running", "completed"]);
  });
});

describe("reconcileConversation", () => {
  it("closes a dangling tool_call and fails the turn", async () => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    expect(result?.annotations).toBeUndefined();
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    return { contentTypes: ["text"], toolCalling: false, fileTools: "string_replace" as const };
  }
  validateConfig(config: ModelConfig): void {
    if (config.model !== "m1" && config.model !== "m2") throw new Error("unknown recording model");
    if (config.preset && config.preset !== "high") throw new Error("unknown recording preset");
  }
  listModels() {
    return [
      { provider: "rec", model: "m1", presets: [{ value: "high" }] },
      { provider: "rec", model: "m2", presets: [{ value: "high" }] },
    ];
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.seen.push(request.modelConfig.model);
    yield { type: "text_delta", text: "ok" };
    yield { type: "message", content: [{ type: "text", text: "ok" }] };
    yield {
      type: "completed",
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
    };
  }
}

function recordingSetup() {
  const provider = new CatalogProvider();
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const engine = new Engine(
    store,
    new PluginHost([{ id: "rec", providers: () => [provider] }]),
    testConfigResolver(),
  );
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // One context item, without splitting the provider-required call/result pair.
    expect(shapeOf(await store.listActiveItems(conv.id))).toEqual([
      "user:go",
      "call:c1",
      "result:c1",
      "context:ctx",
      "call:c2",
      "result:c2",
      "assistant:done",
    ]);
  });

  it("appends deduplicated context only after every result in a parallel tool turn", async () => {
    const parallel: FakeStep = [
      { type: "tool_call", callId: "a", name: "echo", args: {} },
      { type: "tool_call", callId: "b", name: "echo", args: {} },
      { type: "completed", usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } },
    ];
    const { store, engine } = setup([parallel, textStep("done")], {
      toolMiddleware: () => [injectorMw("ctx", "RULES")],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));

    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(shapeOf(await store.listActiveItems(conv.id))).toEqual([
      "user:go",
      "call:a",
      "call:b",
      "result:a",
      "result:b",
      "context:ctx",
      "assistant:done",
    ]);
  });

  it("keeps context earned before an interrupt triggered by tool completion", async () => {
    const { store, engine } = setup([toolStep("c1", "echo", {}), textStep("continued")], {
      toolMiddleware: () => [injectorMw("ctx", "RULES")],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    let interrupt: Promise<void> | undefined;
    engine.subscribe(
      {
        onEvent(event) {
          if (
            isKernelEvent(event) &&
            event.type === "item.appended" &&
            event.item.type === "tool_result"
          ) {
            interrupt = engine.deliver(conv.id, userInput("redo"), "interrupt");
          }
        },
      },
      conv.id,
    );

    await engine.deliver(conv.id, userInput("go"));
    await interrupt;
    await engine.whenIdle(conv.id);

    const items = await store.listItems(conv.id);
    expect(items.filter((item) => item.type === "context")).toHaveLength(1);
    expect(items.findIndex((item) => item.type === "context")).toBeGreaterThan(
      items.findIndex((item) => item.type === "tool_result" && item.callId === "c1"),
    );
  });

  it("re-injects context after a rewind drops it from the active chain", async () => {
    const { store, engine } = setup(
      [toolStep("c1", "echo", {}), textStep("done"), toolStep("c2", "echo", {}), textStep("done2")],
      { toolMiddleware: () => [injectorMw("ctx", "RULES")] },
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
        fileTools: "string_replace",
      }),
      validateConfig: () => {},
      listModels: () => [],
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
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
        fileTools: "string_replace",
      }),
      validateConfig: () => {},
      listModels: () => [],
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
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);
    expect(providerCalled).toBe(false);
    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:go", "assistant:canned"]);
  });
});

describe("Engine — model switching", () => {
  it("setModel persists the new model and emits config.changed", async () => {
    const { store, engine, events } = recordingSetup();
    const conv = await store.createConversation(newConversationInput(recConfig));

    await engine.setModel(conv.id, { provider: "rec", model: "m2" });

    expect((await store.getConversation(conv.id))?.overrides.model).toEqual({
      provider: "rec",
      model: "m2",
    });
    expect(events.filter(isKernelEvent).filter((e) => e.type === "config.changed")).toEqual([
      {
        type: "config.changed",
        conversationId: conv.id,
        config: {
          instructions: "",
          model: { provider: "rec", model: "m2" },
          plugins: {},
        },
      },
    ]);
  });

  it("availableModels aggregates the registered providers' catalogs", () => {
    const { engine } = recordingSetup();
    expect(engine.availableModels()).toEqual([
      { provider: "rec", model: "m1", presets: [{ value: "high" }] },
      { provider: "rec", model: "m2", presets: [{ value: "high" }] },
    ]);
  });

  it("changes presets separately and clears them on every model identity change", async () => {
    const { store, engine } = recordingSetup();
    const conv = await store.createConversation(newConversationInput(recConfig));

    await engine.setPreset(conv.id, { provider: "rec", model: "m1" }, "high");
    expect((await store.getConversation(conv.id))?.overrides.model).toEqual({
      provider: "rec",
      model: "m1",
      preset: "high",
    });

    // Both models deliberately offer the same token. Identity switching must not carry it.
    await engine.setModel(conv.id, { provider: "rec", model: "m2" });
    expect((await store.getConversation(conv.id))?.overrides.model).toEqual({
      provider: "rec",
      model: "m2",
    });
  });

  it("validates model and preset changes before mutating durable overrides", async () => {
    const { store, engine } = recordingSetup();
    const conv = await store.createConversation(newConversationInput(recConfig));
    const before = (await store.getConversation(conv.id))?.overrides;

    await expect(
      engine.setPreset(conv.id, { provider: "rec", model: "m1" }, "bogus"),
    ).rejects.toThrow(/unknown recording preset/);
    await expect(engine.setModel(conv.id, { provider: "rec", model: "missing" })).rejects.toThrow(
      /unknown recording model/,
    );
    await expect(
      engine.setModel(conv.id, {
        provider: "rec",
        model: "m2",
        preset: "high",
      } as unknown as ModelIdentityChange),
    ).rejects.toThrow(/setPreset/);
    expect((await store.getConversation(conv.id))?.overrides).toEqual(before);
  });

  it("reads the model fresh per turn, so a switch between turns lands on the next turn", async () => {
    const { provider, store, engine } = recordingSetup();
    const conv = await store.createConversation(newConversationInput(recConfig));

    await engine.deliver(conv.id, userInput("one"));
    await engine.whenIdle(conv.id);
    await engine.setModel(conv.id, { provider: "rec", model: "m2" });
    await engine.deliver(conv.id, userInput("two"));
    await engine.whenIdle(conv.id);

    expect(provider.seen).toEqual(["m1", "m2"]);
  });

  it("a mid-turn setModel can't change the in-flight turn's model; the next turn picks it up", async () => {
    const gate = new GateTool();
    const provider = new RecordingProvider([
      toolStep("c1", "gate", {}),
      textStep("done"), // second step of turn 1
      textStep("next"), // turn 2
    ]);
    const { store, engine } = setup([], { providers: () => [provider], tools: () => [gate] });
    const conv = await store.createConversation(newConversationInput(CONFIG)); // fake-1

    await engine.deliver(conv.id, userInput("go"));
    await gate.started; // paused mid-turn, after step 1's request, at the gate tool
    await engine.setModel(conv.id, { provider: "fake", model: "fake-2" });
    gate.release();
    await engine.whenIdle(conv.id);

    await engine.deliver(conv.id, userInput("again"));
    await engine.whenIdle(conv.id);

    // The in-flight turn's BOTH requests stayed on fake-1 (the turn snapshot), and its usage was
    // recorded on the same model — only the next turn sees fake-2. (Request model ≡ usage model.)
    expect(provider.requests.map((r) => r.modelConfig.model)).toEqual([
      "fake-1",
      "fake-1",
      "fake-2",
    ]);
    expect((await store.listModelUsage(conv.id)).map((u) => u.model)).toEqual([
      "fake-1",
      "fake-1",
      "fake-2",
    ]);
  });

  it("re-resolves config on load, so an overrides edit before first load is picked up", async () => {
    const provider = new CatalogProvider();
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const conv = await store.createConversation(newConversationInput(recConfig));
    // Edit the durable overrides directly (as a settings/model change does), before any runtime
    // loads it — the creation-time snapshot is gone, so load must re-resolve from the record.
    await store.updateConversationOverrides(conv.id, { model: { provider: "rec", model: "m2" } });

    const engine = new Engine(
      store,
      new PluginHost([{ id: "rec", providers: () => [provider] }]),
      testConfigResolver(),
    );
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(provider.seen).toEqual(["m2"]); // loaded with the edited model, not the creation default
  });
});

describe("Engine — usage recording", () => {
  it("publishes the agent checkpoint before a tool waits and excludes tool time", async () => {
    const gate = new GateTool();
    const usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 20 };
    const { store, engine } = setup([toolStep("call", "gate", {}, usage), textStep("done")], {
      tools: () => [gate],
    });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await gate.started;
    const checkpoint = await store.summarizeModelUsage(conv.id);
    expect(checkpoint.agentContext).toMatchObject({ provider: "fake", model: "fake-1", usage });
    expect(checkpoint.lastTurn).toBeUndefined();
    const [request] = await store.listModelUsage(conv.id);
    expect(request?.requestDurationMs).toBeGreaterThanOrEqual(0);
    gate.release();
    await engine.whenIdle(conv.id);
    const rows = await store.listModelUsage(conv.id);
    expect((await store.summarizeModelUsage(conv.id)).lastTurn?.agentDurationMs).toBe(
      rows.reduce((sum, row) => sum + row.requestDurationMs!, 0),
    );
  });

  it.each([false, true])(
    "settles interrupted approval accounting before terminal status (deactivate=%s)",
    async (deactivate) => {
      const store = new InMemoryStore(counterIdGenerator(), fixedClock());
      const reviewer = new GateProvider("partial review");
      const agent = new FakeProvider([
        toolStep("call", "echo", {}, { inputTokens: 10, outputTokens: 1, cachedReadTokens: 0 }),
      ]);
      const provider: ModelProvider = {
        provider: "fake",
        validateConfig() {},
        capabilities: () => agent.capabilities(),
        listModels: () => [],
        stream: (request, signal) =>
          request.modelConfig.model === "reviewer"
            ? reviewer.stream(request, signal)
            : agent.stream(),
      };
      let markWriteEntered!: () => void;
      let releaseWrite!: () => void;
      const writeEntered = new Promise<void>((resolve) => {
        markWriteEntered = resolve;
      });
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const record = store.recordModelUsage.bind(store);
      let written = false;
      store.recordModelUsage = async (input) => {
        if (input.purpose === "auto-approval") {
          markWriteEntered();
          await writeGate;
        }
        const row = await record(input);
        if (input.purpose === "auto-approval") written = true;
        return row;
      };
      const { engine, events } = setup(
        [],
        {
          providers: () => [provider],
          toolMiddleware: () => [approvalMiddleware(() => true)],
          requestMiddleware: () => [
            {
              id: "review",
              async wrap(_request, ctx) {
                await ctx.models.invoke(
                  {
                    instructions: [],
                    items: [],
                    modelConfig: { provider: "fake", model: "reviewer" },
                  },
                  { purpose: "auto-approval" },
                );
                return { decision: "allow" };
              },
            },
          ],
        },
        store,
      );
      const terminalWrites: boolean[] = [];
      engine.subscribe({
        onEvent(event) {
          if (isKernelEvent(event) && event.type === "turn.status" && event.status !== "running")
            terminalWrites.push(written);
        },
      });
      const conv = await store.createConversation(newConversationInput(CONFIG));
      await engine.deliver(conv.id, userInput("go"));
      await reviewer.started;
      const stopping = deactivate
        ? engine.deactivate(conv.id, { force: true })
        : engine.deliver(conv.id, noContent, "interrupt");
      await writeEntered;
      // A store read observes the public state while the accounting write is explicitly gated.
      expect(await store.getActiveTurn(conv.id)).toBeDefined();
      releaseWrite();
      await stopping;
      await engine.whenIdle(conv.id);
      expect(terminalWrites).toEqual([true]);
      expect(turnStatuses(events)).toEqual(["running", "aborted"]);
      expect(
        (await store.listModelUsage(conv.id)).filter((row) => row.purpose === "auto-approval"),
      ).toMatchObject([{ usage: null }]);
      expect((await store.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
        status: "aborted",
        incomplete: true,
      });
    },
  );

  it("records unknown accounting when a provider throws before returning its stream", async () => {
    const provider: ModelProvider = {
      provider: "fake",
      capabilities: () => new FakeProvider([]).capabilities(),
      listModels: () => [],
      validateConfig() {},
      stream() {
        throw new Error("request setup failed", { cause: new Error("unauthorized") });
      },
    };
    const { store, engine, events } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);
    expect(await store.listModelUsage(conv.id)).toMatchObject([
      { provider: "fake", model: "fake-1", purpose: "agent", usage: null },
    ]);
    expect((await store.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
      status: "failed",
      incomplete: true,
      agentOutputTokens: null,
    });
    expect(turnStatuses(events)).toEqual(["running", "failed"]);
    expect(
      events
        .filter(isKernelEvent)
        .find((event) => event.type === "turn.status" && event.status === "failed"),
    ).toMatchObject({
      error:
        "ModelInvocationFailure: model provider failed\nCaused by: Error: request setup failed\nCaused by: Error: unauthorized",
    });
  });
  it("records one model_usage row per provider request and emits usage events", async () => {
    const u1: Usage = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0 };
    const u2: Usage = { inputTokens: 250, outputTokens: 20, cachedReadTokens: 120 };
    const { store, engine, events } = setup([
      toolStep("c1", "echo", { x: 1 }, u1),
      textStep("done", undefined, u2),
    ]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    const rows = await store.listModelUsage(conv.id);
    expect(rows.map((r) => r.usage)).toEqual([u1, u2]);
    const [item] = await store.listItems(conv.id);
    expect(rows.map((r) => r.turnId)).toEqual([item!.turnId, item!.turnId]);
    for (const row of rows) {
      expect(row.provider).toBe("fake");
      expect(row.model).toBe("fake-1"); // snapshotted from the turn's config
      expect(row.contextBuildId).not.toBeNull();
      expect(row.cost).toBeNull(); // FakeProvider publishes no rate card
    }
    const usageEvents = events.filter(isKernelEvent).filter((e) => e.type === "usage.changed");
    expect(usageEvents.map((e) => e.summary.usage)).toEqual([
      u1,
      addUsage(u1, u2),
      addUsage(u1, u2),
    ]);
    expect(usageEvents.at(-1)?.summary.lastTurn).toMatchObject({
      status: "completed",
      usage: addUsage(u1, u2),
      agentOutputTokens: 30,
    });
    expect(usageEvents.at(-1)?.summary.agentContext).toMatchObject({
      provider: "fake",
      model: "fake-1",
      usage: u2,
    });
  });

  it("records unknown accounting for a step aborted mid-stream (no completed event)", async () => {
    const provider = new GateProvider("hel");
    const { store, engine } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await provider.started;
    await engine.deliver(conv.id, noContent, "interrupt");
    await engine.whenIdle(conv.id);

    expect(await store.listModelUsage(conv.id)).toMatchObject([
      { purpose: "agent", usage: null, cost: null },
    ]);
    expect(await store.summarizeModelUsage(conv.id)).toMatchObject({
      incomplete: true,
      agentContext: { usage: null },
      lastTurn: {
        status: "aborted",
        incomplete: true,
        agentOutputTokens: null,
        agentDurationMs: null,
      },
    });
  });

  it("records a completed invocation whose backend omitted usage", async () => {
    const { store, engine, events } = setup([
      [
        { type: "text_delta", text: "done" },
        { type: "message", content: [{ type: "text", text: "done" }] },
        { type: "completed", usage: null },
      ],
    ]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect((await store.listModelUsage(conv.id)).map((row) => row.usage)).toEqual([null]);
    const usageEvent = events.filter(isKernelEvent).find((event) => event.type === "usage.changed");
    expect(usageEvent).toMatchObject({
      type: "usage.changed",
      summary: { incomplete: true, cost: 0 },
    });
    expect(turnStatuses(events)).toContain("completed");
  });

  it("records terminal usage and preserves partial text before failing the turn", async () => {
    const usage: Usage = { inputTokens: 10, outputTokens: 4, cachedReadTokens: 0 };
    const { store, engine, events } = setup([
      [
        { type: "text_delta", text: "partial" },
        { type: "completed", usage, error: "chat output truncated" },
      ],
    ]);
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(shapeOf(await store.listItems(conv.id))).toEqual(["user:go", "assistant:partial"]);
    expect((await store.listModelUsage(conv.id)).map((row) => row.usage)).toEqual([usage]);
    expect(turnStatuses(events)).toContain("failed");
    expect(
      events
        .filter(isKernelEvent)
        .find((event) => event.type === "turn.status" && event.status === "failed"),
    ).toMatchObject({ error: "Error: chat output truncated" });
  });

  it("pairs terminal-error tool calls without executing them", async () => {
    let executions = 0;
    const tool: Tool = {
      name: "probe",
      description: "must not execute",
      input: { kind: "function", schema: z.unknown() },
      async execute() {
        executions += 1;
        return { forModel: [{ type: "text", text: "executed" }], status: "ok" };
      },
    };
    const { store, engine, events } = setup(
      [
        [
          { type: "tool_call", callId: "call-1", name: "probe", args: {} },
          { type: "completed", usage: null, error: "invalid terminal tool call" },
        ],
      ],
      { tools: () => [tool] },
    );
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    expect(executions).toBe(0);
    expect(shapeOf(await store.listItems(conv.id))).toEqual([
      "user:go",
      "call:call-1",
      "result:call-1",
    ]);
    expect(toolResults(await store.listItems(conv.id))).toMatchObject([
      { callId: "call-1", status: "error" },
    ]);
    expect(turnStatuses(events)).toContain("failed");
  });

  it("prices the row at record time when the provider catalog has a rate card", async () => {
    class PricedProvider extends FakeProvider {
      override listModels() {
        return [
          {
            provider: "fake",
            model: "fake-1",
            pricing: { input: 2, output: 10, cachedRead: 0.2 },
          },
        ];
      }
    }
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedReadTokens: 500_000,
    };
    const provider = new PricedProvider([textStep("done", undefined, usage)]);
    const { store, engine, events } = setup([], { providers: () => [provider] });
    const conv = await store.createConversation(newConversationInput(CONFIG));
    await engine.deliver(conv.id, userInput("go"));
    await engine.whenIdle(conv.id);

    // 500K uncached × $2 + 500K cached × $0.2 + 100K out × $10, per MTok
    const expected = 0.5 * 2 + 0.5 * 0.2 + 0.1 * 10;
    const [row] = await store.listModelUsage(conv.id);
    expect(row?.cost).toBeCloseTo(expected, 10);
    const usageEvent = events.filter(isKernelEvent).find((e) => e.type === "usage.changed");
    expect(usageEvent?.summary.cost ?? null).toBeCloseTo(expected, 10);
  });
});
