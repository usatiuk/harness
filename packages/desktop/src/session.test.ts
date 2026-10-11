import { HarnessRpcHost } from "@harness/service";
import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { sandboxPlugin } from "@harness/sandbox";
import { FakeProvider, counterIdGenerator, fixedClock, textStep } from "@harness/testkit";
import type { ConversationId, TurnId } from "@harness/protocol";
import { DesktopSession } from "./session.ts";

it("shares an earlier history load across callers and permits retry after failure", async () => {
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const service = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    plugins: [{ id: "fake", providers: () => [new FakeProvider([])] }],
  });
  const connections = createInProcessMessageConnectionPair();
  const host = new HarnessRpcHost(service);
  const server = new HarnessRpcSession({
    connection: connections.right,
    host,
    server: { name: "test", version: "1" },
  });
  const desktop = new DesktopSession(connections.left);
  let release: (() => void) | undefined;
  server.start();
  try {
    await desktop.start();
    const conversation = await desktop.client.create({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    const items = [];
    for (let index = 0; index < 300; index++)
      items.push(
        await store.appendItem({
          conversationId: conversation.id as ConversationId,
          turnId: "history" as TurnId,
          type: "message",
          role: "user",
          content: [{ type: "text", text: `Message ${index}` }],
        }),
      );
    const view = await desktop.load(conversation.id);
    expect(view.cursor).not.toBeNull();
    const initialIds = view.items.map((item) => item.id);
    const cursor = view.cursor;
    const history = desktop.client.history.bind(desktop.client);
    const requests = vi.spyOn(desktop.client, "history");
    requests.mockRejectedValueOnce(new Error("history temporarily unavailable"));
    await Promise.all([
      expect(desktop.older(conversation.id)).rejects.toThrow("history temporarily unavailable"),
      expect(desktop.older(conversation.id)).rejects.toThrow("history temporarily unavailable"),
    ]);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(view.items.map((item) => item.id)).toEqual(initialIds);
    expect(view.cursor).toBe(cursor);

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    requests.mockImplementationOnce(async (params) => {
      await gate;
      return history(params);
    });
    const first = desktop.older(conversation.id);
    const second = desktop.older(conversation.id);
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
    expect(view.items.map((item) => item.id)).toEqual(initialIds);
    release!();
    await Promise.all([first, second]);
    expect(view.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(view.cursor).toBeNull();
    await desktop.older(conversation.id);
    expect(requests).toHaveBeenCalledTimes(2);
  } finally {
    release?.();
    await host.shutdown();
    await server.shutdown();
  }
});

it.each([
  { presets: [{ value: "high" }], preset: "" },
  { presets: [{ value: "high" }], preset: "high" },
  { presets: [], preset: "" },
])(
  "creates a conversation through RPC with $presets and preset '$preset'",
  async ({ presets, preset }) => {
    const store = new InMemoryStore(counterIdGenerator(), fixedClock());
    const provider = new FakeProvider([]);
    vi.spyOn(provider, "listModels").mockReturnValue([
      { provider: "fake", model: "fake-1", presets },
    ]);
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      defaults: { model: { provider: "fake", model: "fake-1", preset: "high" } },
      plugins: [{ id: "fake", providers: () => [provider] }, sandboxPlugin],
    });
    const connections = createInProcessMessageConnectionPair();
    const host = new HarnessRpcHost(service);
    const server = new HarnessRpcSession({
      connection: connections.right,
      host,
      server: { name: "test", version: "1" },
    });
    const desktop = new DesktopSession(connections.left);
    server.start();
    try {
      await desktop.start();
      const id = await desktop.create("", "fake\u0000fake-1", "local", "direct", preset);
      const expected = { provider: "fake", model: "fake-1", ...(preset ? { preset } : {}) };
      const conversation = await service.getConversation(id as ConversationId);
      expect(conversation?.config.model).toEqual(expected);
      expect((await store.getConversation(id as ConversationId))?.overrides.model).toEqual(
        expected,
      );
    } finally {
      desktop.client.closeConnection();
      await host.shutdown();
      await server.shutdown();
    }
  },
);

it("reattaches after failed sandbox replacement while another conversation remains usable", async () => {
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const service = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    plugins: [
      {
        id: "fake",
        providers: () => [new FakeProvider([textStep("B completed"), textStep("A retried")])],
      },
    ],
  });
  const connections = createInProcessMessageConnectionPair();
  const host = new HarnessRpcHost(service);
  const server = new HarnessRpcSession({
    connection: connections.right,
    host,
    server: { name: "test", version: "1" },
  });
  const desktop = new DesktopSession(connections.left);
  server.start();
  try {
    await desktop.start();
    const create = () =>
      desktop.client.create({
        overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
      });
    const a = await create(),
      b = await create();
    const original = await desktop.load(a.id);
    const other = await desktop.load(b.id);
    vi.spyOn(service, "prepare").mockRejectedValueOnce(new Error("replacement failed"));
    await expect(desktop.client.reload(a.id)).rejects.toThrow("internal error");
    expect(desktop.views.has(a.id as ConversationId)).toBe(false);
    expect(desktop.views.get(b.id as ConversationId)).toBe(other);
    await desktop.client.deliver(b.id, "continue B", "send");
    await service.whenIdle(b.id as ConversationId);
    await vi.waitFor(() =>
      expect(other.items.some((item) => item.type === "message" && item.role === "assistant")).toBe(
        true,
      ),
    );
    // The first retry also fails: a cached partial view must not make the next retry appear successful.
    vi.spyOn(service, "prepare").mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(desktop.load(a.id)).rejects.toThrow("internal error");
    const recovered = await desktop.load(a.id);
    expect(recovered).not.toBe(original);
    await desktop.client.deliver(a.id, "retry A", "send");
    await service.whenIdle(a.id as ConversationId);
    await vi.waitFor(() =>
      expect(
        recovered.items.some((item) => item.type === "message" && item.role === "assistant"),
      ).toBe(true),
    );
    expect(desktop.disconnected).toBeUndefined();
  } finally {
    await host.shutdown();
    await server.shutdown();
  }
});

it("updates saved titles in both the loaded view and cached conversation list through RPC", async () => {
  const store = new InMemoryStore();
  let release!: () => void;
  const title = new Promise<string>((resolve) => {
    release = () => resolve("Fix conversation naming");
  });
  const service = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    defaults: { model: { provider: "fake", model: "fake-1" } },
    plugins: [
      { id: "fake", providers: () => [new FakeProvider([textStep("done")])] },
      {
        id: "titles",
        services: () => [
          {
            key: "titles",
            for: () => ({ done: Promise.resolve() }),
            onInput: async (service, ctx) => {
              if (ctx.item.seq !== 0) return;
              await ctx.updateTitle("first message", null);
              (service as { done: Promise<void> }).done = title.then((value) =>
                ctx.updateTitle(value, "first message"),
              );
            },
            dispose: (service) => (service as { done: Promise<void> }).done,
          },
        ],
      },
    ],
  });
  const pair = createInProcessMessageConnectionPair();
  const host = new HarnessRpcHost(service);
  const server = new HarnessRpcSession({
    connection: pair.right,
    host,
    server: { name: "test", version: "1" },
  });
  const desktop = new DesktopSession(pair.left);
  server.start();
  try {
    await desktop.start();
    const conversation = await desktop.domain.createConversation();
    const id = conversation.id;
    desktop.conversations = [conversation];
    const view = await desktop.load(conversation.id);
    await desktop.client.deliver(conversation.id, "first message", "send");
    await service.whenIdle(id);
    await vi.waitFor(() => expect(view.conversation.title).toBe("first message"));
    expect(desktop.conversations.find((row) => row.id === id)?.title).toBe("first message");
    release();
    await vi.waitFor(() => expect(view.conversation.title).toBe("Fix conversation naming"));
    expect(desktop.conversations.find((row) => row.id === id)?.title).toBe(
      "Fix conversation naming",
    );
  } finally {
    release();
    desktop.client.closeConnection();
    await host.shutdown();
    await server.shutdown();
  }
});
