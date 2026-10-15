import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import {
  feedbackConfigureRequest,
  feedbackStatusRequest,
  feedbackVoteRequest,
  feedbackRetryRequest,
} from "@harness/feedback/client";
import { MemorySecretStore } from "@harness/secrets";
import * as credentials from "./credential-store.ts";
import { buildServerHarness } from "./index.ts";

it("collects a rich vote case through RPC, queues offline delivery, and retries the same identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "feedback-rpc-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("MAI_TOKEN", "fixture-controller-token");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
  ])
    vi.stubEnv(key, "");
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({
    store: new MemorySecretStore(),
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
      tokenEnv: "MAI_TOKEN",
    });
    const conversation = await harness.service.createConversation({
      overrides: { model: { provider: "demo", model: "demo-1" } },
    });
    await client.attach(conversation.id);
    const turn = await harness.store.createTurn(conversation.id);
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
        native_request: { messages: [{ role: "user", content: "Original context" }] },
      },
    });
    await expect(
      client.peer.request(feedbackVoteRequest, { ...params, comment: "Different intent" }),
    ).rejects.toThrow();
    await client.peer.request(feedbackConfigureRequest, {
      enabled: false,
      endpoint: `http://127.0.0.1:${address.port}`,
      tokenEnv: "MAI_TOKEN",
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
