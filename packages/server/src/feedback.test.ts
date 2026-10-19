import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Shell startup is an OS edge; the real cold-owner path is covered in shell-startup.test.ts.
vi.mock("@harness/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@harness/execution")>()),
  initializeUserShellEnvironment: vi.fn(async () => {}),
}));
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import {
  feedbackConfigureRequest,
  feedbackStatusRequest,
  feedbackVoteRequest,
  feedbackRetryRequest,
  feedbackDecisionsRequest,
} from "@harness/feedback/client";
import { MemorySecretStore } from "@harness/secrets";
import * as credentials from "./credential-store.ts";
import { buildServerHarness } from "./index.ts";

it("collects a rich vote case through RPC, queues offline delivery, and retries the same identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "feedback-rpc-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("MAI_TOKEN", "");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
  ])
    vi.stubEnv(key, "");
  const secretStore = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({
    store: new MemorySecretStore(),
    kind: null,
  });
  const chooseStore = vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({
    store: secretStore,
    kind: "file",
  });
  let online = false;
  const received: Record<string, unknown>[] = [];
  const http = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      expect(request.headers.authorization).toBe("Bearer fixture-controller-token");
      if (!online) {
        response.writeHead(503).end();
        return;
      }
      const packet = JSON.parse(body) as { id: string };
      received.push(packet);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: packet.id }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "feedback-test", version: "1" },
  });
  try {
    await client.start();
    expect((await client.peer.request(feedbackStatusRequest, {})).enabled).toBe(false);
    await client.peer.request(feedbackConfigureRequest, {
      enabled: true,
      endpoint: `http://127.0.0.1:${address.port}`,
      token: "fixture-controller-token",
    });
    const status = await client.peer.request(feedbackStatusRequest, {});
    expect(status.configured).toBe(true);
    expect(chooseStore).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain("fixture-controller-token");
    const { readGlobalSettings } = await import("@harness/config");
    expect(JSON.stringify(await readGlobalSettings(home))).not.toContain(
      "fixture-controller-token",
    );
    const conversation = await harness.service.createConversation({
      overrides: { model: { provider: "demo", model: "demo-1" } },
    });
    await client.attach(conversation.id);
    const turn = await harness.store.createTurn(conversation.id);
    const firstReasoning = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "reasoning",
      content: [{ type: "text", text: "I will edit before inspecting callers" }],
    });
    const firstCall = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "tool_call",
      callId: "edit-1",
      name: "edit_file",
      args: { path: "public.py" },
    });
    for (const item of [firstReasoning, firstCall])
      await harness.store.putPluginState("model-evidence", conversation.id, `item:${item.id}`, {
        attemptId: "first-edit",
      });
    await harness.store.putProviderPayload({
      itemId: firstReasoning.id,
      provider: "fixture",
      model: "fixture",
      type: "chat_reasoning",
      version: 1,
      payload: null,
    });
    await harness.store.putPluginState("model-evidence", conversation.id, "first-edit", {
      nativeRequest: { messages: [{ role: "user", content: "Explain this API" }] },
    });
    const siblingCall = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "tool_call",
      callId: "edit-2",
      name: "edit_file",
      args: { path: "sibling.py" },
    });
    await harness.store.putPluginState(
      "model-evidence",
      conversation.id,
      `item:${siblingCall.id}`,
      { attemptId: "first-edit" },
    );
    await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "tool_result",
      callId: "edit-1",
      status: "ok",
      content: [{ type: "text", text: "Edited" }],
    });
    const selected = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Unwanted response" }],
    });
    await harness.store.putPluginState("model-evidence", conversation.id, `item:${selected.id}`, {
      attemptId: "attempt-1",
    });
    await harness.store.putPluginState("model-evidence", conversation.id, "attempt-1", {
      request: { items: [{ item: selected, payload: { signature: "private-artifact" } }] },
      nativeRequest: { messages: [{ role: "user", content: "Original context" }] },
    });
    const later = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Later unrelated action" }],
    });
    await harness.store.putPluginState("model-evidence", conversation.id, `item:${later.id}`, {
      attemptId: "later",
    });
    const backfill = await client.peer.request(feedbackDecisionsRequest, {
      conversationId: conversation.id,
      itemId: selected.id,
    });
    expect(backfill).toMatchObject({
      version: 1,
      conversationId: conversation.id,
      itemId: selected.id,
    });
    expect(backfill.decisions.map((decision) => decision.id)).toEqual(["first-edit", "attempt-1"]);
    expect(backfill.decisions[0]).toMatchObject({
      item_ids: [firstReasoning.id, firstCall.id, siblingCall.id],
      native_request: { messages: [{ role: "user", content: "Explain this API" }] },
      original_outputs: [
        { reasoningKind: "exposed_text" },
        { type: "tool_call", name: "edit_file" },
        { type: "tool_call", name: "edit_file" },
      ],
    });
    const toolVote = await client.peer.request(feedbackDecisionsRequest, {
      conversationId: conversation.id,
      itemId: firstCall.id,
    });
    expect(toolVote.decisions.map((entry) => entry.id)).toEqual(["first-edit"]);
    expect(toolVote.decisions[0]!.item_ids).toEqual([
      firstReasoning.id,
      firstCall.id,
      siblingCall.id,
    ]);
    expect(JSON.stringify(backfill)).not.toContain("private-artifact");
    expect(
      backfill.decisions
        .flatMap((decision) => decision.original_outputs)
        .some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            item["type"] === "tool_result",
        ),
    ).toBe(false);
    const id = randomUUID();
    const params = {
      id,
      conversationId: conversation.id,
      itemId: selected.id,
      vote: "down" as const,
      comment: "Too broad",
    };
    expect(await client.peer.request(feedbackVoteRequest, params)).toMatchObject({
      status: "queued",
      url: `http://127.0.0.1:${address.port}/#/feedback/${id}`,
    });
    await client.peer.request(feedbackRetryRequest, {});
    expect((await client.peer.request(feedbackStatusRequest, {})).pending).toBe(1);
    expect(await readFile(join(home, "feedback", `${id}.json`), "utf8")).not.toContain(
      "fixture-controller-token",
    );
    await client.peer.request(feedbackConfigureRequest, {
      enabled: true,
      endpoint: "http://127.0.0.1:1",
      token: null,
    });
    expect((await client.peer.request(feedbackStatusRequest, {})).configured).toBe(false);
    await client.peer.request(feedbackRetryRequest, {});
    expect((await client.peer.request(feedbackStatusRequest, {})).pending).toBe(1);
    await client.peer.request(feedbackConfigureRequest, {
      enabled: true,
      endpoint: `http://127.0.0.1:${address.port}`,
      token: null,
    });
    expect((await client.peer.request(feedbackStatusRequest, {})).configured).toBe(true);
    online = true;
    await client.peer.request(feedbackRetryRequest, {});
    expect((await client.peer.request(feedbackStatusRequest, {})).pending).toBe(0);
    expect((await client.peer.request(feedbackVoteRequest, params)).status).toBe("delivered");
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain("private-artifact");
    expect(received[0]).toMatchObject({
      id,
      comment: "Too broad",
      evidence: {
        invocation_id: "attempt-1",
        decisions: [{ id: "first-edit" }, { id: "attempt-1" }],
        native_request: { messages: [{ role: "user", content: "Original context" }] },
      },
    });
    await expect(
      client.peer.request(feedbackVoteRequest, { ...params, comment: "Different intent" }),
    ).rejects.toThrow();
    await harness.store.putPluginState("model-evidence", conversation.id, "first-edit", {
      nativeRequest: { messages: [{ role: "user", content: "large".repeat(800000) }] },
    });
    const bounded = await client.peer.request(feedbackDecisionsRequest, {
      conversationId: conversation.id,
      itemId: selected.id,
    });
    expect(bounded.decisions[0]).toMatchObject({ id: "first-edit", native_request: null });
    expect(bounded.decisions[0]!.limitations.join(" ")).toContain("omitted");
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(3 * 1024 * 1024);
    await harness.store.putPluginState("model-evidence", conversation.id, "first-edit", {
      nativeRequest: { messages: [{ role: "user", content: "large".repeat(7_000_000) }] },
    });
    const boundedVoteId = randomUUID();
    expect(
      await client.peer.request(feedbackVoteRequest, { ...params, id: boundedVoteId }),
    ).toMatchObject({ status: "queued" });
    await client.peer.request(feedbackRetryRequest, {});
    const boundedVote = received.find((packet) => packet["id"] === boundedVoteId) as {
      evidence: { decisions: { id: string; native_request: unknown; limitations: string[] }[] };
    };
    expect(boundedVote.evidence.decisions[0]).toMatchObject({
      id: "first-edit",
      native_request: null,
    });
    expect(boundedVote.evidence.decisions[0]!.limitations.join(" ")).toContain("omitted");
    expect(Buffer.byteLength(JSON.stringify(boundedVote))).toBeLessThan(32 * 1024 * 1024);
    const historical = await harness.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Historical without capture" }],
    });
    const unavailable = await client.peer.request(feedbackDecisionsRequest, {
      conversationId: conversation.id,
      itemId: historical.id,
    });
    expect(unavailable.limitations.join(" ")).toContain("no recorded model invocation");
    const other = await harness.service.createConversation({
      overrides: { model: { provider: "demo", model: "demo-1" } },
    });
    await client.attach(other.id);
    await expect(
      client.peer.request(feedbackDecisionsRequest, {
        conversationId: other.id,
        itemId: selected.id,
      }),
    ).rejects.toThrow();
    await client.peer.request(feedbackConfigureRequest, {
      enabled: false,
      token: null,
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    await expect(
      client.peer.request(feedbackVoteRequest, { ...params, id: randomUUID() }),
    ).rejects.toThrow();
  } finally {
    client.closeConnection();
    await harness.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
