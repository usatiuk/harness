import { unusedCodeEvaluator } from "@harness/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  HarnessClient,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
} from "@harness/client";
import { SqliteStore } from "@harness/store-sqlite";
import {
  isKernelEvent,
  textOf,
  type HarnessEvent,
  type ModelProvider,
  type ModelRequest,
} from "@harness/protocol";
import { HarnessService } from "./service.ts";
import { HarnessRpcHost } from "./rpc-host.ts";
import { HarnessRpcSession } from "./rpc-session.ts";

it("keeps previews ephemeral and finalized phases, reasoning and search hints durable through SQLite and RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-native-output-"));
  const path = join(dir, "store.db");
  const store = new SqliteStore(path);
  const requests: ModelRequest[] = [];
  let entered!: () => void, release!: () => void;
  const preview = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ModelProvider = {
    provider: "fake",
    providerOptions: { webSearch: true },
    capabilities: () => ({
      contentTypes: ["text"],
      toolCalling: true,
      customToolInput: { supported: false, grammars: [] },
      preferredEditTool: "replace",
    }),
    validateConfig: () => {},
    listModels: () => [],
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "temporary", phase: "commentary" };
      entered();
      await gate;
      yield { type: "message", content: [{ type: "text", text: "comment" }], phase: "commentary" };
      yield { type: "provider_output", content: [{ type: "text", text: "Searched example" }] };
      yield {
        type: "reasoning",
        content: [{ type: "text", text: "readable reasoning" }],
        payload: {
          provider: "fake",
          model: request.modelConfig.model,
          type: "reasoning",
          version: 1,
          payload: { signature: "OPAQUE" },
        },
      };
      yield {
        type: "message",
        content: [{ type: "text", text: "[Source](https://example.com)" }],
        phase: "final_answer",
      };
      yield { type: "message", content: [{ type: "text", text: "null phase" }], phase: null };
      yield { type: "message", content: [{ type: "text", text: "unreported phase" }] };
      yield { type: "message", content: [{ type: "text", text: "other phase" }], phase: "other" };
      yield {
        type: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
        costIncomplete: true,
        inputTokensAreContext: false,
        providerUsage: { searches: 1 },
      };
    },
  };
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
    home: "/nonexistent-native-output-home",
    plugins: [{ id: "fake", providers: () => [provider] }],
  });
  const pair = createInProcessMessageConnectionPair();
  const host = new HarnessRpcHost(service);
  const session = new HarnessRpcSession({
    connection: pair.right,
    host,
    server: { name: "harness", version: "0.0.0" },
  });
  const raw = new HarnessClient({ connection: pair.left, client: { name: "test", version: "1" } });
  const client = new HarnessDomainClient(raw);
  session.start();
  try {
    await client.start();
    const conversation = await client.createConversation({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    await client.prepare(conversation.id);
    const events: HarnessEvent[] = [];
    client.subscribe(conversation.id, (event) => {
      events.push(event);
    });
    await client.send(conversation.id, "go");
    await preview;
    expect((await store.listOwnedItems(conversation.id)).map((item) => item.type)).toEqual([
      "message",
    ]);
    expect(JSON.stringify(await client.getItems(conversation.id))).not.toContain("temporary");
    release();
    await service.whenIdle(conversation.id);
    const items = await client.getItems(conversation.id);
    const messages = items.filter((item) => item.type === "message" && item.role === "assistant");
    expect(messages.map((item) => (item.type === "message" ? item.phase : undefined))).toEqual([
      "commentary",
      "final_answer",
      null,
      undefined,
      "other",
    ]);
    expect(messages[3]).not.toHaveProperty("phase");
    expect(messages.map((item) => textOf(item.content))).toEqual([
      "comment",
      "[Source](https://example.com)",
      "null phase",
      "unreported phase",
      "other phase",
    ]);
    expect(items.find((item) => item.type === "reasoning")).toMatchObject({
      content: [{ type: "text", text: "readable reasoning" }],
    });
    expect(items.find((item) => item.type === "provider_output")).toMatchObject({
      content: [{ type: "text", text: "Searched example" }],
    });
    expect(JSON.stringify(items)).not.toContain("OPAQUE");
    expect(JSON.stringify(items)).not.toContain("temporary");
    const hints = items.filter((item) => item.type === "provider_output");
    expect(await store.getProviderPayloads(hints.map((item) => item.id))).toEqual([]);
    const rows = await store.listModelUsage(conversation.id);
    expect(rows[0]).toMatchObject({
      providerUsage: { searches: 1 },
      costIncomplete: true,
      inputTokensAreContext: false,
    });
    expect((await store.getContextBuild(rows[0]!.contextBuildId!))?.providerOptions).toEqual({
      webSearch: true,
    });
    expect(
      events.some(
        (event) =>
          isKernelEvent(event) && event.type === "text_delta" && event.phase === "commentary",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "usage.changed").at(-1)).toMatchObject({
      summary: { costIncomplete: true, usage: { inputTokens: 10 }, agentContext: { usage: null } },
    });
    expect(requests).toHaveLength(1);
    await session.shutdown();
    await host.shutdown();
    store.close();
    const reopened = new SqliteStore(path);
    try {
      expect(await reopened.listOwnedItems(conversation.id)).toEqual(items);
      expect((await reopened.listModelUsage(conversation.id))[0]).toMatchObject({
        providerUsage: { searches: 1 },
        costIncomplete: true,
        inputTokensAreContext: false,
      });
      const summary = await reopened.summarizeModelUsage(conversation.id);
      expect(summary.usage.inputTokens).toBe(10);
      expect(summary.agentContext?.usage).toBeNull();
      expect(summary.lastInputTokens).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    release();
    await session.shutdown();
    await host.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
