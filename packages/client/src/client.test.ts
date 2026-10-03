import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HARNESS_PROTOCOL_VERSION,
  conversationAttachRequest,
  conversationReloadRequest,
  conversationDetachedNotification,
  conversationEventNotification,
  conversationPresetSetRequest,
  defineNotification,
  serverModelsRequest,
  type AttachResult,
  type ConversationId,
} from "@harness/protocol";
import { HarnessClient } from "./client.ts";
import { HarnessDomainClient } from "./domain.ts";
import { createInProcessMessageConnectionPair } from "./in-process.ts";
import { RpcPeer } from "./peer.ts";

const extensionEvent = defineNotification({
  direction: "server-to-client",
  method: "test.extension.event",
  params: z.strictObject({ rootConversationId: z.string(), value: z.string() }),
});

const attachment: AttachResult = {
  root: {
    id: "root",
    workspaceRoot: null,
    overrides: {},
    head: null,
    createdAt: 0,
    config: {
      instructions: "",
      model: { provider: "test", model: "test", preset: null },
      tools: null,
      plugins: {},
    },
  },
  members: [
    {
      conversation: {
        id: "root",
        workspaceRoot: null,
        overrides: {},
        head: null,
        createdAt: 0,
        config: {
          instructions: "",
          model: { provider: "test", model: "test", preset: null },
          tools: null,
          plugins: {},
        },
      },
      live: { conversationId: "root", status: "idle", turnId: null, pendingInput: [] },
    },
  ],
  usage: {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: null,
    },
    incomplete: false,
    cost: 0,
    lastInputTokens: null,
  },
  plugins: { test: { value: "snapshot" } },
};

describe("HarnessClient attachment", () => {
  it("projects a complete model selection to the identity expected by preset changes", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    let selection: unknown;
    server.onRequest(conversationPresetSetRequest, ({ expected }) => {
      selection = expected;
      return null;
    });
    server.listen();
    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    await client.start();
    const model = { provider: "demo", model: "demo-1", preset: "high" };
    await client.setPreset("root", model, "low");
    expect(selection).toEqual({ provider: "demo", model: "demo-1" });
    client.closeConnection();
  });

  it("does not accumulate unobserved descendant output or disconnect observed roots", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.onRequest(conversationAttachRequest, () => attachment);
    server.listen();
    const wire = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    const client = new HarnessDomainClient(wire);
    await client.start();
    await client.attachedConversation("root" as ConversationId);
    const observed: string[] = [];
    client.subscribe("root" as ConversationId, (event) => observed.push(event.type));
    for (let index = 0; index < 4; index++)
      await server.notify(conversationEventNotification, {
        rootConversationId: "root",
        conversationId: "child",
        event: { type: "text.delta", turnId: "child-turn", text: "x".repeat(1024 * 1024) },
      });
    await server.notify(conversationEventNotification, {
      rootConversationId: "root",
      conversationId: "root",
      event: { type: "text.delta", turnId: "root-turn", text: "root remains live" },
    });
    await expect(wire.models()).resolves.toMatchObject({ models: [] });
    expect(observed).toContain("text_delta");
    client.closeConnection();
  });
  it("keeps child routing from a fresh reload suffix through later detachment", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    server.onRequest(conversationAttachRequest, () => attachment);
    server.onRequest(conversationReloadRequest, async () => {
      await server.notify(conversationDetachedNotification, { rootConversationId: "root" });
      await server.notify(conversationEventNotification, {
        rootConversationId: "root",
        conversationId: "child",
        event: { type: "head.changed", head: null },
      });
      return { status: "reloaded" as const, attachment };
    });
    server.listen();
    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    const detached: string[][] = [];
    client.subscribe((event) => {
      if (event.type === "detached") detached.push(event.conversationIds);
    });
    await client.start();
    await client.attach("root");
    await client.reload("root");
    await server.notify(conversationDetachedNotification, { rootConversationId: "root" });
    await vi.waitFor(() => expect(detached).toEqual([["root"], ["root", "child"]]));
    client.closeConnection();
  });
  it("applies the snapshot before an early plugin notification", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    server.onRequest(conversationAttachRequest, async () => {
      await server.notify(extensionEvent, { rootConversationId: "root", value: "event" });
      return attachment;
    });
    server.listen();

    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    const order: string[] = [];
    client.subscribe((event) => {
      if (event.type === "attached") {
        order.push(`snapshot:${JSON.stringify(event.attachment.plugins.test)}`);
      }
    });
    client.peer.onNotification(extensionEvent, (event) => {
      client.receive(event.rootConversationId, event, () => order.push(event.value));
    });
    await client.start();
    await client.attach("root");

    expect(order).toEqual(['snapshot:{"value":"snapshot"}', "event"]);
    client.closeConnection();
  });

  it("applies a reattach snapshot before that root's buffered suffix", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    let attaches = 0;
    server.onRequest(conversationAttachRequest, async () => {
      if (++attaches === 2) {
        await server.notify(extensionEvent, { rootConversationId: "root", value: "terminal" });
      }
      return attachment;
    });
    server.listen();
    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    const order: string[] = [];
    client.subscribe((event) => {
      if (event.type === "attached") order.push("snapshot");
    });
    client.peer.onNotification(extensionEvent, (event) => {
      client.receive(event.rootConversationId, event, () => order.push(event.value));
    });
    await client.start();
    await client.attach("root");
    order.length = 0;
    await client.attach("root");

    expect(order).toEqual(["snapshot", "terminal"]);
    client.closeConnection();
  });

  it("closes when the bounded attach suffix overflows", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    server.onRequest(conversationAttachRequest, async () => {
      started();
      await blocked;
      return attachment;
    });
    server.listen();
    const protocolError = vi.fn();
    const client = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
      onProtocolError: protocolError,
    });
    await client.start();
    const attaching = client.attach("root");
    await entered;
    const payload = { rootConversationId: "root", value: "x".repeat(1_100_000) };
    client.receive("root", payload, () => {});
    client.receive("root", payload, () => {});
    release();

    await expect(attaching).rejects.toThrow();
    expect(protocolError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "attachment event buffer exceeded its byte limit" }),
    );
  });

  it("seeds current root turn and pending input before the screen subscribes", async () => {
    const connections = createInProcessMessageConnectionPair();
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    }));
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.onRequest(conversationAttachRequest, () => ({
      ...attachment,
      members: [
        {
          ...attachment.members[0]!,
          live: {
            conversationId: "root",
            status: "running" as const,
            turnId: "turn-1",
            pendingInput: [{ intent: "queue" as const, text: "next" }],
          },
        },
      ],
    }));
    server.listen();
    const wire = new HarnessClient({
      connection: connections.left,
      client: { name: "client", version: "1" },
    });
    const client = new HarnessDomainClient(wire);
    await client.start();
    await client.attachedConversation("root" as ConversationId);
    const observed: string[] = [];
    client.subscribe("root" as ConversationId, (event) => observed.push(event.type));

    expect(observed).toEqual(["inbox", "usage.changed", "turn.status"]);
    client.closeConnection();
  });
});
