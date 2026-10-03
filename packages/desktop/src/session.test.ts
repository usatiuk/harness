import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, counterIdGenerator, fixedClock, textStep } from "@harness/testkit";
import type { ConversationId } from "@harness/protocol";
import { DesktopSession } from "./session.ts";

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
  const server = new HarnessRpcSession({
    connection: connections.right,
    service,
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
    await server.shutdown();
  }
});
