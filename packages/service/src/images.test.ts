import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { SqliteStore } from "@harness/store-sqlite";
import { FakeProvider, textStep, toolStep, unusedCodeEvaluator } from "@harness/testkit";
import type {
  ConversationId,
  ImageContent,
  ModelRequest,
  Tool,
  WireConversationEvent,
} from "@harness/protocol";
import { HarnessRpcHost } from "./rpc-host.ts";
import { HarnessRpcSession } from "./rpc-session.ts";
import { HarnessService } from "./service.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = (size = png.length): ImageContent => ({
  type: "image",
  mediaType: "image/png",
  data: Buffer.concat([png, Buffer.alloc(size - png.length, 21)]).toString("base64"),
});

function server(
  store: SqliteStore,
  images = true,
  tools: Tool[] = [],
  home = "/nonexistent-harness-image-home",
) {
  const requests: ModelRequest[] = [];
  const fake = new FakeProvider(
    tools.length ? [toolStep("read", tools[0]!.name, {}), textStep("seen")] : [textStep("seen")],
  );
  const service = new HarnessService({
    store,
    codeEvaluator: unusedCodeEvaluator,
    home,
    plugins: [
      {
        id: "images",
        tools: () => tools,
        providers: () => [
          {
            provider: fake.provider,
            capabilities: () => ({
              ...fake.capabilities(),
              contentTypes: images ? ["text", "image"] : ["text"],
            }),
            listModels: () => [
              ...fake
                .listModels()
                .map((model) => ({ ...model, contextWindow: 128_000, supportsImages: true })),
              { provider: fake.provider, model: "text-only", supportsImages: false },
              { provider: fake.provider, model: "unknown" },
            ],
            validateConfig: () => {},
            stream: (request: ModelRequest) => {
              requests.push(request);
              return fake.stream();
            },
          },
        ],
      },
    ],
  });
  const host = new HarnessRpcHost(service);
  function connect() {
    const pair = createInProcessMessageConnectionPair();
    const session = new HarnessRpcSession({
      connection: pair.right,
      host,
      server: { name: "test", version: "1" },
    });
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "test", version: "1" },
    });
    session.start();
    return { client, session };
  }
  return { service, host, connect, requests };
}

const create = (client: HarnessClient) =>
  client.create({ overrides: { model: { provider: "fake", model: "fake-1" } } });

describe("images across the public conversation boundary", () => {
  it("preserves image-only delivery and chunked history exactly through reconnect and SQLite restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-image-history-"));
    const path = join(directory, "store.db");
    let store = new SqliteStore(path);
    let owner = server(store);
    let connection = owner.connect();
    const attachment = image(900_000);
    try {
      await connection.client.start();
      const conversation = await create(connection.client);
      await connection.client.attach(conversation.id);
      await connection.client.deliver(conversation.id, "", "send", [attachment]);
      await owner.service.whenIdle(conversation.id as ConversationId);
      expect(
        owner.requests[0]?.items.find(({ item }) => item.type === "message" && item.role === "user")
          ?.item,
      ).toMatchObject({ content: [attachment] });
      await connection.session.shutdown(false);
      connection = owner.connect();
      await connection.client.start();
      await connection.client.attach(conversation.id);
      const checkHistory = async () => {
        const page = await connection.client.history({ conversationId: conversation.id });
        const reference = page.entries.find((entry) => entry.kind === "itemRef");
        if (reference?.kind !== "itemRef") throw new Error("large image must use chunked history");
        expect(reference.byteLength).toBeGreaterThan(1024 * 1024);
        const recovered = await connection.client.readItem(conversation.id, reference);
        expect(recovered).toMatchObject({ type: "message", role: "user", content: [attachment] });
      };
      await checkHistory();
      await connection.session.shutdown(false);
      await owner.host.shutdown();
      store.close();
      store = new SqliteStore(path);
      owner = server(store);
      connection = owner.connect();
      await connection.client.start();
      await connection.client.attach(conversation.id);
      await checkHistory();
    } finally {
      await connection.session.shutdown(false);
      await owner.host.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores tool images in their tool result and sends them to the next model request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-image-tool-"));
    const store = new SqliteStore(join(directory, "store.db"));
    const attachment = image();
    const tool: Tool = {
      name: "read_image",
      description: "returns an image",
      essential: true,
      input: { kind: "function", schema: z.object({}) },
      execute: async () => ({ status: "ok", forModel: [attachment] }),
    };
    const owner = server(store, true, [tool]);
    const { client, session } = owner.connect();
    try {
      await client.start();
      const conversation = await create(client);
      await client.attach(conversation.id);
      await client.deliver(conversation.id, "read image", "send");
      await owner.service.whenIdle(conversation.id as ConversationId);
      const page = await client.history({ conversationId: conversation.id });
      expect(
        page.entries.filter((entry) => entry.kind === "item" && entry.item.type === "tool_result"),
      ).toMatchObject([{ kind: "item", item: { type: "tool_result", content: [attachment] } }]);
      expect(
        owner.requests[1]?.items.find(({ item }) => item.type === "tool_result")?.item,
      ).toMatchObject({ content: [attachment] });
    } finally {
      await session.shutdown(false);
      await owner.host.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows switching but rejects image context at the request boundary without losing history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-image-switch-"));
    const store = new SqliteStore(join(directory, "store.db"));
    const owner = server(store, true, [], directory);
    const { client, session } = owner.connect();
    const attachment = image();
    try {
      await client.start();
      const conversation = await create(client);
      const id = conversation.id as ConversationId;
      await client.attach(id);
      await client.deliver(id, "", "send", [attachment]);
      await owner.service.whenIdle(id);
      await client.setModel(id, "fake", "text-only");
      expect((await client.get(id))?.config.model.model).toBe("text-only");
      const events: WireConversationEvent[] = [];
      const unsubscribe = client.subscribe((event) => {
        if (event.type === "conversation") events.push(event.event);
      });
      await expect(client.deliver(id, "", "send", [attachment])).rejects.toThrow(
        /does not support image input/,
      );
      await client.deliver(id, "continue", "send");
      await owner.service.whenIdle(id);
      expect(owner.requests).toHaveLength(1);
      await vi.waitFor(() =>
        expect(
          events
            .filter((event) => event.type === "turn.changed")
            .find((event) => event.status === "failed")?.error,
        ).toContain("does not support image input"),
      );
      unsubscribe();
      expect(
        (await store.listActiveItems(id)).find(
          (item) => item.type === "message" && item.role === "user",
        ),
      ).toMatchObject({ content: [attachment] });
      await client.setModel(id, "fake", "unknown");
      await client.deliver(id, "continue", "send");
      await owner.service.whenIdle(id);
      expect(owner.requests).toHaveLength(2);
      expect(
        owner.requests[1]!.items.some(
          ({ item }) => "content" in item && item.content.some((block) => block.type === "image"),
        ),
      ).toBe(true);
      // An ordinary compaction summary bounds active context; old images stay in the log.
      const turn = await store.createTurn(id);
      await store.appendItem({
        conversationId: id,
        turnId: turn.id,
        type: "compaction",
        content: [{ type: "text", text: "Image contents summarized" }],
      });
      await store.updateTurn(turn.id, "completed");
      await client.setModel(id, "fake", "text-only");
      await client.deliver(id, "continue from summary", "send");
      await owner.service.whenIdle(id);
      expect(owner.requests).toHaveLength(3);
      expect(
        owner.requests[2]!.items.some(
          ({ item }) => "content" in item && item.content.some((block) => block.type === "image"),
        ),
      ).toBe(false);
      expect(
        (await store.listOwnedItems(id)).some(
          (item) => "content" in item && item.content.some((block) => block.type === "image"),
        ),
      ).toBe(true);
    } finally {
      await session.shutdown(false);
      await owner.host.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects image input for a text-only adapter before accepting a message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-image-unsupported-"));
    const store = new SqliteStore(join(directory, "store.db"));
    const owner = server(store, false);
    const { client, session } = owner.connect();
    try {
      await client.start();
      const conversation = await create(client);
      await client.attach(conversation.id);
      await expect(client.deliver(conversation.id, "", "send", [image()])).rejects.toThrow(
        /image|content/i,
      );
      expect((await client.history({ conversationId: conversation.id })).entries).toEqual([]);
      expect(owner.requests).toEqual([]);
    } finally {
      await session.shutdown(false);
      await owner.host.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
