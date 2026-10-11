import { HarnessRpcHost } from "@harness/service";
import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { sandboxPlugin } from "@harness/sandbox";
import { FakeProvider, counterIdGenerator, fixedClock, textStep } from "@harness/testkit";
import type { ConversationId } from "@harness/protocol";
import { DesktopSession } from "./session.ts";

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
