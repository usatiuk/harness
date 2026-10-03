import { describe, expect, it, vi } from "vitest";
import {
  conversationAttachRequest,
  conversationEventNotification,
  type ConversationId,
  type Plugin,
} from "@harness/protocol";
import {
  HarnessClient,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
} from "@harness/client";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, counterIdGenerator, fixedClock, textStep } from "@harness/testkit";
import { HarnessService } from "./service.ts";
import { HarnessRpcSession } from "./rpc-session.ts";

const createHarness = (
  steps = [textStep("done")],
  plugins: Plugin[] = [],
  onError?: (error: unknown) => void,
) => {
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const service = new HarnessService({
    store,
    home: "/nonexistent-harness-home",
    plugins: [{ id: "fake", providers: () => [new FakeProvider(steps)] }, ...plugins],
  });
  const connections = createInProcessMessageConnectionPair();
  const session = new HarnessRpcSession({
    connection: connections.right,
    service,
    server: { name: "harness", version: "0.0.0" },
    ...(onError ? { onError } : {}),
  });
  const client = new HarnessClient({
    connection: connections.left,
    client: { name: "test", version: "1" },
  });
  session.start();
  return { store, service, session, client };
};

const createConversation = (client: HarnessClient) =>
  client.create({
    overrides: {
      instructions: "be helpful",
      model: { provider: "fake", model: "fake-1" },
    },
  });

describe("HarnessRpcSession", () => {
  it("fails shutdown after draining every root when a real plugin disposer fails", async () => {
    const { client, service, session } = createHarness(
      [textStep("done")],
      [
        {
          id: "broken-resource",
          services: () => [
            {
              key: "broken",
              for: () => ({}),
              dispose: () => {
                throw new Error("cleanup failed");
              },
            },
          ],
        },
      ],
    );
    await client.start();
    const root = await createConversation(client);
    await client.attach(root.id);
    service.service(root.id as ConversationId, "broken");
    await expect(session.shutdown()).rejects.toThrow("Conversation shutdown failed");
    expect(service.conversationTreeState(root.id as ConversationId)).toEqual([]);
    expect(session.isAttached(root.id as ConversationId)).toBe(false);
  });
  it("preserves attachment and buffered events when reload fails before teardown", async () => {
    const { client, service, session } = createHarness();
    await client.start();
    const a = await createConversation(client);
    await client.attach(a.id);
    const received: string[] = [];
    client.subscribe((event) => {
      received.push(event.type === "conversation" ? event.event.type : event.type);
    });
    vi.spyOn(service, "deactivateSession").mockImplementationOnce(async () => {
      await session.server.peer.notify(conversationEventNotification, {
        rootConversationId: a.id,
        conversationId: a.id,
        event: { type: "head.changed", head: null },
      });
      throw new Error("teardown not started");
    });
    await expect(client.reload(a.id)).rejects.toThrow("internal error");
    expect(received).toEqual(["head.changed"]);
    expect(session.isAttached(a.id as ConversationId)).toBe(true);
    await client.deliver(a.id, "still attached", "send");
    await service.whenIdle(a.id as ConversationId);
    expect((await client.history({ conversationId: a.id })).entries).toHaveLength(2);
    await session.shutdown();
  });
  it("reports detachment on failed replacement and permits a clean retry without affecting B", async () => {
    const { client, service, session } = createHarness([
      textStep("B completed"),
      textStep("A retried"),
    ]);
    await client.start();
    const a = await createConversation(client),
      b = await createConversation(client);
    await client.attach(a.id);
    await client.attach(b.id);
    const detached: string[] = [];
    client.subscribe((event) => {
      if (event.type === "detached") detached.push(event.rootConversationId);
    });
    vi.spyOn(service, "prepare").mockRejectedValueOnce(new Error("replacement failed"));
    await expect(client.reload(a.id)).rejects.toThrow("internal error");
    expect(detached).toEqual([a.id]);
    expect(session.isAttached(a.id as ConversationId)).toBe(false);
    expect(service.conversationTreeState(a.id as ConversationId)).toEqual([]);
    expect(session.isAttached(b.id as ConversationId)).toBe(true);
    await client.deliver(b.id, "continue B", "send");
    await service.whenIdle(b.id as ConversationId);
    await client.attach(a.id);
    await client.deliver(a.id, "retry A", "send");
    await service.whenIdle(a.id as ConversationId);
    expect((await client.history({ conversationId: a.id })).entries).toHaveLength(2);
    await session.shutdown();
  });

  it("reports actual detachment despite disposer failure and leaves B usable", async () => {
    const { client, service, session } = createHarness(
      [textStep("B survived")],
      [
        {
          id: "broken-resource",
          services: () => [
            {
              key: "broken",
              for: () => ({}),
              dispose: () => {
                throw new Error("cleanup failed");
              },
            },
          ],
        },
      ],
    );
    await client.start();
    const a = await createConversation(client),
      b = await createConversation(client);
    await client.attach(a.id);
    await client.attach(b.id);
    service.service(a.id as ConversationId, "broken");
    const detached: string[][] = [];
    client.subscribe((event) => {
      if (event.type === "detached") detached.push(event.conversationIds);
    });
    await expect(client.close(a.id)).rejects.toThrow("internal error");
    expect(detached).toEqual([[a.id]]);
    expect(session.isAttached(a.id as ConversationId)).toBe(false);
    expect(service.conversationTreeState(a.id as ConversationId)).toEqual([]);
    await client.deliver(b.id, "continue", "send");
    await service.whenIdle(b.id as ConversationId);
    expect((await client.history({ conversationId: b.id })).entries).toHaveLength(2);
    await client.attach(a.id);
    await expect(client.close(a.id)).resolves.toEqual({ status: "closed" });
    await session.shutdown();
  });
  it("drives core conversation work through the in-process public contract", async () => {
    const { client, service } = createHarness();
    await client.start();
    const models = await client.models();
    expect(models.models).toEqual([]);

    const conversation = await createConversation(client);
    const observed: string[] = [];
    client.subscribe((event) => {
      observed.push(
        event.type === "conversation" ? `${event.conversationId}:${event.event.type}` : event.type,
      );
    });
    const attachment = await client.attach(conversation.id);
    expect(attachment.root.id).toBe(conversation.id);
    expect(observed).toEqual(["attached"]);

    await client.deliver(conversation.id, "hello", "send");
    await service.whenIdle(conversation.id as ConversationId);
    await vi.waitFor(() =>
      expect(observed.filter((entry) => entry.endsWith("item.appended"))).toHaveLength(2),
    );

    const page = await client.history({ conversationId: conversation.id });
    expect(page.anchor).not.toBeNull();
    expect(
      page.entries.map((entry) => (entry.kind === "item" ? entry.item.type : entry.kind)),
    ).toEqual(["message", "message"]);
    expect(
      page.entries.flatMap((entry) =>
        entry.kind === "item" && entry.item.type === "message" ? [entry.item.role] : [],
      ),
    ).toEqual(["assistant", "user"]);

    const listed = await client.list();
    expect(listed.conversations.map((entry) => entry.id)).toEqual([conversation.id]);
    expect((await client.get(conversation.id))?.id).toBe(conversation.id);
  });

  it("keeps a second attached root alive when the first closes", async () => {
    const { client, service } = createHarness([textStep("second root")]);
    await client.start();
    const first = await createConversation(client);
    const second = await createConversation(client);
    await client.attach(first.id);
    await client.attach(second.id);

    await expect(client.close(first.id)).resolves.toEqual({ status: "closed" });
    await client.deliver(second.id, "continue", "send");
    await service.whenIdle(second.id as ConversationId);

    const page = await client.history({ conversationId: second.id });
    expect(page.entries).toHaveLength(2);
    expect((await client.get(first.id))?.id).toBe(first.id);
  });

  it("rejects runtime work before attachment", async () => {
    const { client, service, session } = createHarness();
    await client.start();
    const conversation = await createConversation(client);
    await expect(client.deliver(conversation.id, "must attach", "send")).rejects.toThrow(
      "internal error",
    );
    expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]);
    client.closeConnection();
    await session.shutdown(false);
  });

  it("stops operation admission before root-scope teardown", async () => {
    const { client, session } = createHarness([]);
    await client.start();
    const conversation = await createConversation(client);
    await client.attach(conversation.id);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const active = session.runAttached(conversation.id as ConversationId, () => blocked);
    const closing = client.close(conversation.id, true);
    await vi.waitFor(() =>
      expect(session.isAttached(conversation.id as ConversationId)).toBe(false),
    );
    await expect(
      session.runAttached(conversation.id as ConversationId, async () => undefined),
    ).rejects.toThrow("not attached");
    release();
    await expect(active).rejects.toThrow("operation cancelled");
    await expect(closing).resolves.toEqual({ status: "closed" });
  });

  it("references and reconstructs an item larger than a history page", async () => {
    const { client, store } = createHarness([]);
    await client.start();
    const conversation = await createConversation(client);
    const turn = await store.createTurn(conversation.id as ConversationId);
    const item = await store.appendItem({
      conversationId: conversation.id as ConversationId,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(8_000) }],
    });
    await client.attach(conversation.id);

    const page = await client.history({ conversationId: conversation.id, maxBytes: 1024 });
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    if (entry?.kind !== "itemRef") throw new Error("expected an item reference");
    const reconstructed = await client.readItem(conversation.id, entry);
    expect(entry.itemId).toBe(item.id);
    expect(entry.byteLength).toBeGreaterThan(8_000);
    expect(reconstructed.id).toBe(item.id);
    expect(reconstructed.type === "message" && reconstructed.content[0]?.text).toHaveLength(8_000);
  });

  it("terminates and cleans up when an authoritative attachment exceeds its bound", async () => {
    const { client, service, session } = createHarness([]);
    session.registerSnapshot("huge", () => ({ value: "x".repeat(2 * 1024 * 1024) }));
    await client.start();
    const conversation = await createConversation(client);

    await expect(client.attach(conversation.id)).rejects.toThrow();
    await session.shutdown(false);
    expect(session.isAttached(conversation.id as ConversationId)).toBe(false);
    expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]);
  });

  it("reports cleanup failure after rejecting an oversized attachment", async () => {
    const errors: unknown[] = [];
    const { client, service, session } = createHarness(
      [],
      [
        {
          id: "broken-resource",
          services: () => [
            {
              key: "broken",
              for: () => ({}),
              dispose: () => {
                throw new Error("cleanup failed");
              },
            },
          ],
        },
      ],
      (error) => errors.push(error),
    );
    session.registerSnapshot("huge", (root) => {
      service.service(root, "broken");
      return { value: "x".repeat(2 * 1024 * 1024) };
    });
    await client.start();
    const conversation = await createConversation(client);
    await expect(client.attach(conversation.id)).rejects.toThrow();
    await vi.waitFor(() =>
      expect(
        errors.some(
          (error) =>
            error instanceof AggregateError && error.message === "Conversation shutdown failed",
        ),
      ).toBe(true),
    );
    expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]);
  });

  it("does not let an in-flight attachment outlive connection shutdown", async () => {
    const { client, service, session } = createHarness([]);
    await client.start();
    const conversation = await createConversation(client);
    const prepare = service.prepare.bind(service);
    let entered!: () => void;
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(service, "prepare").mockImplementation(async (id) => {
      entered();
      await blocked;
      await prepare(id);
    });

    const attaching = client.attach(conversation.id);
    await preparing;
    client.closeConnection();
    const shutdown = session.shutdown(false);
    release();

    await expect(attaching).rejects.toThrow();
    await shutdown;
    expect(session.isAttached(conversation.id as ConversationId)).toBe(false);
    expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]);
  });

  it("rolls back attachment when cancellation reaches its final continuation", async () => {
    const { client, service, session } = createHarness([]);
    const controller = new AbortController();
    session.registerSnapshot("cancel", () => {
      controller.abort();
      return null;
    });
    await client.start();
    const conversation = await createConversation(client);

    await expect(
      client.peer.request(
        conversationAttachRequest,
        { conversationId: conversation.id },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("request cancelled");
    await vi.waitFor(() =>
      expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]),
    );
    expect(session.isAttached(conversation.id as ConversationId)).toBe(false);
    await session.shutdown(false);
  });

  it("cancels a long semantic handler before waiting for connection teardown", async () => {
    const { client, service, session } = createHarness([]);
    await client.start();
    const conversation = await createConversation(client);
    await client.attach(conversation.id);
    let entered!: () => void;
    const compacting = new Promise<void>((resolve) => (entered = resolve));
    let operationSignal: AbortSignal | undefined;
    vi.spyOn(service, "compact").mockImplementation(async (_id, signal) => {
      operationSignal = signal;
      entered();
      return new Promise<"noop">((_resolve, reject) => {
        const cancel = () => reject(new Error("cancelled"));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    });

    const request = client.compact(conversation.id);
    await compacting;
    client.closeConnection();
    await session.shutdown(false);

    expect(operationSignal?.aborted).toBe(true);
    await expect(request).rejects.toThrow();
    expect(service.conversationTreeState(conversation.id as ConversationId)).toEqual([]);
  });

  it("shuts down every attached root scope when the connection closes", async () => {
    const { client, service, session } = createHarness([]);
    await client.start();
    const conversation = await createConversation(client);
    await client.attach(conversation.id);
    expect(service.conversationTreeState(conversation.id as ConversationId)).toHaveLength(1);

    client.closeConnection();
    await session.shutdown(false);
    expect(service.conversationTreeState(conversation.id as ConversationId)).toHaveLength(0);
  });

  it("walks every bounded history and conversation-list page", async () => {
    const { client, store } = createHarness([]);
    const domain = new HarnessDomainClient(client);
    await domain.start();
    const conversations = [];
    for (let index = 0; index < 101; index++) {
      conversations.push(
        await domain.createConversation({
          overrides: { instructions: "", model: { provider: "fake", model: "fake-1" } },
        }),
      );
    }
    expect(await domain.listConversations()).toHaveLength(101);

    const target = conversations[0]!;
    const turn = await store.createTurn(target.id);
    for (let index = 0; index < 205; index++) {
      await store.appendItem({
        conversationId: target.id,
        turnId: turn.id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: String(index) }],
      });
    }
    await domain.attachedConversation(target.id);
    const items = await domain.getItems(target.id);
    expect(items).toHaveLength(205);
    expect(items[0]).toMatchObject({ type: "message", content: [{ text: "0" }] });
    expect(items.at(-1)).toMatchObject({ type: "message", content: [{ text: "204" }] });
    domain.closeConnection();
  });
});
