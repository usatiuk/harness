import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import {
  FakeProvider,
  EchoTool,
  counterIdGenerator,
  fixedClock,
  textStep,
  toolStep,
} from "@harness/testkit";
import {
  ApprovalClient,
  approvalPlugin,
  approvalDecideRequest,
  APPROVAL_CLIENT_CONTRACT_VERSION,
} from "@harness/approval";
import type { ConversationId, PluginEntry } from "@harness/protocol";
import { registerApprovalServer } from "./approvals.ts";
import { registerFeatureServer } from "./features.ts";
import { HarnessPluginClient, FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { activitiesPlugin } from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function sharedHarness(provider: FakeProvider, plugins: PluginEntry[] = []) {
  const service = new HarnessService({
    store: new InMemoryStore(counterIdGenerator(), fixedClock()),
    home: "/nonexistent-harness-home",
    plugins: [{ id: "fake", providers: () => [provider] }, ...plugins],
    defaults: { model: { provider: "fake", model: "fake-1" } },
  });
  const host = new HarnessRpcHost(service);
  const sessions: HarnessRpcSession[] = [];
  const connect = async () => {
    const pair = createInProcessMessageConnectionPair();
    const session = new HarnessRpcSession({
      connection: pair.right,
      host,
      server: { name: "test", version: "1" },
    });
    sessions.push(session);
    registerApprovalServer(session);
    registerFeatureServer(session);
    session.start();
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "test", version: "1" },
      plugins: [
        { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
        ...FEATURE_PLUGIN_CONTRACTS,
      ],
    });
    const approvals = new ApprovalClient(client);
    const plugins = new HarnessPluginClient(client, approvals);
    await client.start();
    return { client, approvals, plugins, session };
  };
  return {
    service,
    host,
    connect,
    close: async () => {
      await host.shutdown();
      await Promise.all(sessions.map((session) => session.shutdown()));
    },
  };
}

it("keeps accepted and queued turns alive after disconnect and suppresses missed stream suffixes on fresh attach", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new FakeProvider([]);
  provider.stream = async function* () {
    yield { type: "text_delta", text: "prefix " };
    started();
    await gate;
    yield { type: "text_delta", text: "suffix" };
    yield { type: "completed", usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } };
  };
  const harness = sharedHarness(provider);
  try {
    const first = await harness.connect();
    const root = await first.client.create({});
    await first.client.attach(root.id);
    await first.client.deliver(root.id, "first", "send");
    await entered;
    await first.client.deliver(root.id, "queued", "queue");
    first.client.closeConnection();
    await first.session.shutdown(false);
    const second = await harness.connect();
    const attachment = await second.client.attach(root.id);
    expect(attachment.members[0]?.live).toMatchObject({
      status: "running",
      pendingInput: [{ intent: "queue", text: "queued" }],
    });
    const deltas: string[] = [];
    second.client.subscribe((event) => {
      if (event.type === "conversation" && event.event.type === "text.delta")
        deltas.push(event.event.text);
    });
    release();
    await harness.service.whenIdle(root.id as ConversationId);
    const history = await second.client.history({ conversationId: root.id });
    expect(
      history.entries.flatMap((entry) =>
        entry.kind === "item" && entry.item.type === "message" && entry.item.role === "assistant"
          ? [entry.item.content]
          : [],
      ),
    ).toEqual([
      [{ type: "text", text: "prefix suffix" }],
      [{ type: "text", text: "prefix suffix" }],
    ]);
    await vi.waitFor(() => expect(deltas).toEqual(["prefix ", "suffix"]));
  } finally {
    release();
    await harness.close();
  }
});

it("retains human approvals without a client, reprojects them, and accepts exactly one racing decision", async () => {
  const harness = sharedHarness(
    new FakeProvider([toolStep("call", "echo", {}), textStep("done")]),
    [approvalPlugin, { id: "echo", tools: () => [new EchoTool()] }],
  );
  try {
    const first = await harness.connect();
    const root = await first.client.create({
      overrides: { plugins: { approval: { tools: { echo: "ask" } } } },
    });
    await first.client.attach(root.id);
    await first.client.deliver(root.id, "execute", "send");
    await vi.waitFor(() =>
      expect(harness.service.pendingRequests(root.id as ConversationId)).toHaveLength(1),
    );
    first.client.closeConnection();
    await first.session.shutdown(false);
    const second = await harness.connect(),
      third = await harness.connect();
    const a = await second.client.attach(root.id),
      b = await third.client.attach(root.id);
    expect(a.plugins["approval"]).toEqual(b.plugins["approval"]);
    const pending = harness.service.pendingRequests(root.id as ConversationId)[0]!;
    const decisions = await Promise.all([
      second.client.peer.request(approvalDecideRequest, {
        conversationId: root.id,
        requestId: pending.requestId,
        decision: "allow",
      }),
      third.client.peer.request(approvalDecideRequest, {
        conversationId: root.id,
        requestId: pending.requestId,
        decision: "deny",
      }),
    ]);
    expect(decisions.filter((decision) => decision.resolved)).toHaveLength(1);
    await harness.service.whenIdle(root.id as ConversationId);
    expect(harness.service.pendingRequests(root.id as ConversationId)).toEqual([]);
    const history = await second.client.history({ conversationId: root.id });
    expect(
      history.entries.filter((entry) => entry.kind === "item" && entry.item.type === "tool_result"),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it("leaves shared work intact after a second observer's oversized attach and detaches all observers on explicit close", async () => {
  const harness = sharedHarness(new FakeProvider([textStep("done")]));
  try {
    const first = await harness.connect(),
      second = await harness.connect();
    const root = await first.client.create({});
    await first.client.attach(root.id);
    second.session.registerSnapshot("huge", () => ({ text: "x".repeat(2 * 1024 * 1024) }));
    await expect(second.client.attach(root.id)).rejects.toThrow();
    await first.client.deliver(root.id, "still alive", "send");
    await harness.service.whenIdle(root.id as ConversationId);
    const third = await harness.connect();
    await third.client.attach(root.id);
    const detached: string[] = [];
    third.client.subscribe((event) => {
      if (event.type === "detached") detached.push(event.rootConversationId);
    });
    await first.client.close(root.id);
    await vi.waitFor(() => expect(detached).toEqual([root.id]));
    expect(third.session.isAttached(root.id as ConversationId)).toBe(false);
  } finally {
    await harness.close();
  }
});

it("reconciles an approval resolved in the microtask after a fresh attach snapshot", async () => {
  const harness = sharedHarness(
    new FakeProvider([toolStep("call", "echo", {}), textStep("done")]),
    [approvalPlugin, { id: "echo", tools: () => [new EchoTool()] }],
  );
  try {
    const first = await harness.connect();
    const root = await first.client.create({
      overrides: { plugins: { approval: { tools: { echo: "ask" } } } },
    });
    await first.client.attach(root.id);
    await first.client.deliver(root.id, "execute", "send");
    await vi.waitFor(() =>
      expect(harness.service.pendingRequests(root.id as ConversationId)).toHaveLength(1),
    );
    const pending = harness.service.pendingRequests(root.id as ConversationId)[0]!;
    const second = await harness.connect();
    second.session.registerSnapshot("resolve-after-snapshot", () => {
      queueMicrotask(() =>
        harness.service.respond(pending.conversationId, pending.requestId, { decision: "allow" }),
      );
      return null;
    });
    const seen: string[] = [];
    second.approvals.subscribe(root.id, (event) => seen.push(event.type));
    await second.client.attach(root.id);
    await vi.waitFor(() => expect(seen).toEqual(["created", "resolved"]));
    await harness.service.whenIdle(root.id as ConversationId);
  } finally {
    await harness.close();
  }
});

it("drains admitted non-root requests before shutdown completes and rejects later admission", async () => {
  const harness = sharedHarness(new FakeProvider([]));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = harness.host.request(() => gate);
  let stopped = false;
  const shutdown = harness.host.shutdown().then(() => {
    stopped = true;
  });
  await expect(harness.host.request(() => undefined)).rejects.toThrow("server is stopping");
  expect(stopped).toBe(false);
  release();
  await admitted;
  await shutdown;
  expect(stopped).toBe(true);
});

it("keeps a real shell process running after its creator disconnects and broadcasts completion to another client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-shared-shell-"));
  const release = join(directory, "release");
  const harness = sharedHarness(new FakeProvider([]), [activitiesPlugin, sandboxPlugin]);
  try {
    const first = await harness.connect(),
      second = await harness.connect();
    const root = await first.client.create({ cwd: directory });
    await first.client.attach(root.id);
    await second.client.attach(root.id);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const activityEvents: string[] = [];
    second.plugins.subscribe(root.id as ConversationId, (event) => activityEvents.push(event.type));
    const script = `const fs=require('fs');const p=${JSON.stringify(release)};fs.watch(${JSON.stringify(directory)},()=>{if(fs.existsSync(p))process.exit(0)});console.log('ready');`;
    const command = `"${process.execPath}" -e "${script.replaceAll('"', '\\"')}"`;
    const shell = first.plugins.runShell(root.id as ConversationId, command, (_id, event) => {
      if (event.type === "data" && event.text.includes("ready")) ready();
    });
    await shell.accepted;
    await started;
    first.client.closeConnection();
    await first.session.shutdown(false);
    expect(second.plugins.runningActivities(root.id as ConversationId)).toBe(1);
    await writeFile(release, "finish");
    await vi.waitFor(() => expect(activityEvents).toContain("activity.exited"));
    expect(second.plugins.runningActivities(root.id as ConversationId)).toBe(0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
