import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { SqliteStore } from "@harness/store-sqlite";
import { InMemoryStore } from "@harness/store";
import {
  unusedCodeEvaluator,
  FakeProvider,
  GateProvider,
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
import {
  SubagentsDefinition,
  isDismissed,
  rosterPage,
  spawnSubagent,
  subagentsListRequest,
  subagentsEventNotification,
  type SubagentPage,
} from "@harness/subagents";
import type { ConversationId, PluginEntry, ModelProvider, Store } from "@harness/protocol";
import { registerApprovalServer } from "./approvals.ts";
import { registerFeatureServer } from "./features.ts";
import { HarnessPluginClient, FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { activitiesPlugin } from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function sharedHarness(
  provider: ModelProvider,
  plugins: PluginEntry[] = [],
  store: Store = new InMemoryStore(counterIdGenerator(), fixedClock()),
) {
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
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
    yield { type: "message", content: [{ type: "text", text: "prefix suffix" }] };
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

it("expires one shared human-only approval with no clients, persists denial and rejects a late answer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const harness = sharedHarness(
    new FakeProvider([toolStep("call", "echo", {}), textStep("done")]),
    [approvalPlugin, { id: "echo", tools: () => [new EchoTool()] }],
  );
  try {
    const first = await harness.connect();
    const root = await first.client.create({
      overrides: {
        plugins: { approval: { tools: { echo: "ask-human" }, humanApprovalTimeoutSeconds: 1 } },
      },
    });
    await first.client.attach(root.id);
    await first.client.deliver(root.id, "execute", "send");
    await vi.waitFor(() =>
      expect(harness.service.pendingRequests(root.id as ConversationId)).toHaveLength(1),
    );
    const pending = harness.service.pendingRequests(root.id as ConversationId)[0]!;
    first.client.closeConnection();
    await first.session.shutdown(false);
    await vi.advanceTimersByTimeAsync(1000);
    await harness.service.whenIdle(root.id as ConversationId);
    expect(harness.service.pendingRequests(root.id as ConversationId)).toEqual([]);
    const second = await harness.connect();
    await second.client.attach(root.id);
    expect(
      await second.client.peer.request(approvalDecideRequest, {
        conversationId: root.id,
        requestId: pending.requestId,
        decision: "allow",
      }),
    ).toEqual({ resolved: false });
    const history = await second.client.history({ conversationId: root.id });
    expect(
      history.entries.some(
        (entry) =>
          entry.kind === "item" &&
          entry.item.type === "tool_result" &&
          entry.item.annotations?.["approval"] &&
          JSON.stringify(entry.item.annotations["approval"]).includes("human approval timed out"),
      ),
    ).toBe(true);
  } finally {
    await harness.close();
    vi.useRealTimers();
  }
});

it("inspects durable subagent trees over RPC and rejects client mutations without disrupting parent ownership", async () => {
  const provider: ModelProvider = new FakeProvider([
    textStep("Child complete"),
    textStep("Nested complete"),
  ]);
  const harness = sharedHarness(provider);
  try {
    const first = await harness.connect();
    const root = await first.client.create({});
    await first.client.attach(root.id);
    const child = await spawnSubagent({
      runner: harness.service,
      parent: root.id as ConversationId,
      callId: "child",
      agentName: "explore",
      name: "Review authentication",
      slug: "auth-review",
      task: "review",
      overrides: {},
    });
    await child.done;
    await harness.service.whenIdle(child.childId);
    const nested = await spawnSubagent({
      runner: harness.service,
      parent: child.childId,
      callId: "nested",
      agentName: "general",
      name: "Check tests",
      slug: "tests",
      task: "check",
      overrides: {},
    });
    await nested.done;
    await harness.service.whenIdle(nested.childId);
    const failed = await spawnSubagent({
      runner: harness.service,
      parent: root.id as ConversationId,
      callId: "failed",
      agentName: "explore",
      name: "Failed review",
      slug: "failed",
      task: "fail",
      overrides: {},
    });
    await failed.done;
    await harness.service.whenIdle(failed.childId);
    const gate = new GateProvider("Live child output");
    provider.stream = gate.stream.bind(gate);
    const active = await spawnSubagent({
      runner: harness.service,
      parent: child.childId,
      callId: "active",
      agentName: "explore",
      name: "Live review",
      slug: "live",
      task: "live",
      overrides: {},
    });
    await gate.started;
    const page = await first.plugins.listSubagents(root.id as ConversationId);
    expect(page.running).toBe(1);
    expect(page.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child.childId,
          name: "Review authentication",
          slug: "auth-review",
          status: "completed",
          hasChildren: true,
        }),
        expect.objectContaining({ id: failed.childId, status: "failed" }),
      ]),
    );
    const nestedPage = await first.plugins.listSubagents(child.childId);
    expect(nestedPage.running).toBe(1);
    expect(nestedPage.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: nested.childId, status: "completed" }),
        expect.objectContaining({ id: active.childId, status: "running" }),
      ]),
    );
    const one = await first.client.peer.request(subagentsListRequest, {
      conversationId: root.id,
      limit: 1,
      cursor: null,
    });
    expect(one.children).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
    const two = await first.client.peer.request(subagentsListRequest, {
      conversationId: root.id,
      limit: 1,
      cursor: one.nextCursor,
    });
    expect(two.children).toHaveLength(1);
    expect(two.children[0]?.id).not.toBe(one.children[0]?.id);
    expect(two.nextCursor).toBeNull();
    const metadata = await first.plugins.inspectSubagent(nested.childId);
    expect(metadata?.ancestors.at(-1)).toEqual({
      id: child.childId,
      name: "Review authentication",
    });
    for (const intent of ["send", "queue", "steer", "interrupt"] as const)
      await expect(
        first.client.deliver(active.childId, "Unrequested input", intent),
      ).rejects.toThrow("read-only");
    await expect(first.client.setTitle(child.childId, "rename")).rejects.toThrow("read-only");
    await expect(first.client.reload(child.childId, true)).rejects.toThrow("read-only");
    const allIds = (await first.client.list({})).conversations.map(
      (row) => row.id as ConversationId,
    );
    expect(await first.plugins.topLevel(allIds)).toEqual(new Set([root.id]));
    first.client.closeConnection();
    await first.session.shutdown(false);
    const second = await harness.connect();
    const attachment = await second.client.attach(active.childId);
    expect(attachment.root.id).toBe(root.id);
    expect(
      attachment.members.find((member) => member.conversation.id === active.childId)?.live.status,
    ).toBe("running");
    active.kill();
    await active.done;
    await harness.service.whenIdle(active.childId);
    expect(
      (await second.client.history({ conversationId: active.childId })).entries.length,
    ).toBeGreaterThan(0);
    expect((await second.plugins.listSubagents(root.id as ConversationId)).running).toBe(0);
    expect((await second.plugins.listSubagents(child.childId)).children).toContainEqual(
      expect.objectContaining({ id: active.childId, status: "aborted" }),
    );
  } finally {
    await harness.close();
  }
});

it("keeps legacy subagents inspectable without inventing names or resurrecting stopped work", async () => {
  const harness = sharedHarness(new FakeProvider([]));
  try {
    const connection = await harness.connect();
    const root = await connection.client.create({});
    await connection.client.attach(root.id);
    const child = await harness.service.createConversation({ parentId: root.id as ConversationId });
    await harness.service.putPluginState(
      "subagents",
      child.id,
      "spawn",
      { parent: { conversationId: root.id, callId: "old" }, agent: "explore" },
      root.id,
    );
    expect(await connection.plugins.inspectSubagent(child.id)).toMatchObject({
      name: "explore",
      slug: child.id,
    });
    expect((await connection.plugins.listSubagents(root.id as ConversationId)).children).toEqual([
      expect.objectContaining({ id: child.id, name: "explore", slug: child.id, status: "aborted" }),
    ]);
    await connection.client.attach(child.id);
    expect((await connection.client.history({ conversationId: child.id })).entries).toEqual([]);
    await expect(connection.client.deliver(child.id, "resume", "send")).rejects.toThrow(
      "read-only",
    );
  } finally {
    await harness.close();
  }
});

it("keeps dismissed branches hidden and retained stale children Stopped after SQLite reopen without launching providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-inspect-restart-"));
  const path = join(dir, "history.db");
  const before = new SqliteStore(path);
  const root = await before.createConversation({
    workspaceRoot: null,
    overrides: { model: { provider: "fake", model: "fake-1" } },
  });
  const child = await before.createConversation({
    workspaceRoot: null,
    overrides: { model: { provider: "fake", model: "fake-1" } },
  });
  await before.putPluginState(
    "subagents",
    child.id,
    "spawn",
    {
      parent: { conversationId: root.id, callId: "stale" },
      agent: "explore",
      name: "Interrupted review",
      slug: "review",
    },
    root.id,
  );
  await before.putPluginState("subagents", child.id, "dismissed", true);
  const turn = await before.createTurn(child.id);
  const retained = await before.createConversation({
    workspaceRoot: null,
    overrides: { model: { provider: "fake", model: "fake-1" } },
  });
  await before.putPluginState(
    "subagents",
    retained.id,
    "spawn",
    {
      parent: { conversationId: root.id, callId: "retained-stale" },
      agent: "explore",
      name: "Retained review",
      slug: "retained",
    },
    root.id,
  );
  await before.createTurn(retained.id);
  before.close();
  const reopened = new SqliteStore(path);
  const provider = new FakeProvider([]);
  const stream = vi.spyOn(provider, "stream");
  const harness = sharedHarness(provider, [], reopened);
  try {
    const connection = await harness.connect();
    expect(await isDismissed(harness.service, child.id)).toBe(true);
    expect((await rosterPage(harness.service, root.id, 20)).map((row) => row.id)).toEqual([
      retained.id,
    ]);
    const page = await connection.plugins.listSubagents(root.id);
    expect(page.running).toBe(0);
    expect(page.children).toEqual([
      expect.objectContaining({ id: retained.id, status: "aborted" }),
    ]);
    expect((await reopened.getLatestTurn(child.id))?.status).toBe("running");
    expect(
      harness.service.conversationTreeState(root.id).map((member) => member.conversation.id),
    ).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
    expect((await connection.client.attach(child.id)).root.id).toBe(root.id);
    expect((await reopened.getLatestTurn(child.id))?.status).toBe("failed");
    expect((await reopened.getLatestTurn(child.id))?.id).toBe(turn.id);
    expect(stream).not.toHaveBeenCalled();
    expect(await connection.client.close(root.id, true)).toEqual({ status: "closed" });
    expect(harness.service.conversationTreeState(root.id)).toEqual([]);
  } finally {
    await harness.close();
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("filters dismissed GUI branches before paging, reports honest counts/expanders and publishes changes without cancelling live descendants", async () => {
  const provider: ModelProvider = new FakeProvider(
    Array.from({ length: 8 }, () => textStep("Finished")),
  );
  const subagents = new SubagentsDefinition();
  const harness = sharedHarness(provider, [activitiesPlugin, subagents]);
  subagents.bindRunner(harness.service);
  try {
    const connection = await harness.connect();
    const root = await connection.client.create({});
    await connection.client.attach(root.id);
    const foreign = await harness.connect();
    const otherRoot = await foreign.client.create({});
    await foreign.client.attach(otherRoot.id);
    const unattached = await harness.connect();
    const foreignEvents: unknown[] = [];
    const unattachedEvents: unknown[] = [];
    foreign.client.peer.onNotification(subagentsEventNotification, (event) =>
      foreignEvents.push(event),
    );
    unattached.client.peer.onNotification(subagentsEventNotification, (event) =>
      unattachedEvents.push(event),
    );
    for (let i = 0; i < 5; i++) {
      const child = await spawnSubagent({
        runner: harness.service,
        parent: root.id as ConversationId,
        callId: `seed-${i}`,
        agentName: "general",
        name: `Task ${i}`,
        slug: `task-${i}`,
        task: "Work",
        overrides: {},
      });
      await child.done;
      await harness.service.whenIdle(child.childId);
    }
    const initial = await connection.plugins.listSubagents(root.id as ConversationId);
    expect(initial.children).toHaveLength(5);
    const firstId = initial.children[0]!.id as ConversationId;
    const middleId = initial.children[2]!.id as ConversationId;
    // A retained parent's only dismissed child must not leave a stale expander.
    const retainedId = initial.children[1]!.id as ConversationId;
    const finished = await spawnSubagent({
      runner: harness.service,
      parent: retainedId,
      callId: "finished",
      agentName: "general",
      name: "Finished nested",
      slug: "finished",
      task: "Work",
      overrides: {},
    });
    await finished.done;
    await harness.service.whenIdle(finished.childId);
    expect(
      (await connection.plugins.listSubagents(root.id as ConversationId)).children.find(
        (row) => row.id === retainedId,
      )?.hasChildren,
    ).toBe(true);
    await harness.service.putPluginState("subagents", finished.childId, "dismissed", true);
    const gate = new GateProvider("Still working after dismissal");
    provider.stream = gate.stream.bind(gate);
    const active = await spawnSubagent({
      runner: harness.service,
      parent: middleId,
      callId: "live",
      agentName: "general",
      name: "Live work",
      slug: "live",
      task: "Wait",
      overrides: {},
    });
    await gate.started;
    expect((await connection.plugins.listSubagents(root.id as ConversationId)).running).toBe(1);
    const events: unknown[] = [];
    const unsubscribe = connection.plugins.subscribe(root.id as ConversationId, (event) => {
      if (event.type === "subagents.changed") events.push(event);
    });
    const dismiss = async (to: string) => {
      const scripted = new FakeProvider([
        toolStep(`dismiss-${to}`, "subagent_dismiss", { to }),
        textStep("Dismissed"),
      ]);
      provider.stream = scripted.stream.bind(scripted);
      await harness.service.deliver(root.id as ConversationId, "Dismiss task", "send");
      await harness.service.whenIdle(root.id as ConversationId);
    };
    await dismiss(firstId);
    await dismiss(middleId);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toContainEqual({
      type: "subagents.changed",
      conversationId: root.id,
      dismissedId: middleId,
    });
    // Round trips settle any earlier notifications on these transports.
    await foreign.client.history({ conversationId: otherRoot.id });
    await unattached.client.list();
    expect(foreignEvents).toEqual([]);
    expect(unattachedEvents).toEqual([]);
    const listed: string[] = [];
    let cursor: { createdAt: number; id: string } | null = null;
    do {
      const page: SubagentPage = await connection.client.peer.request(subagentsListRequest, {
        conversationId: root.id,
        limit: 1,
        cursor,
      });
      expect(page.children).toHaveLength(1);
      expect(page.running).toBe(0);
      expect(page.children[0]!.hasChildren).toBe(false);
      listed.push(page.children[0]!.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(listed).toHaveLength(3);
    expect(listed).not.toContain(firstId);
    expect(listed).not.toContain(middleId);
    expect((await connection.plugins.listSubagents(middleId)).children).toEqual([]);
    expect((await connection.plugins.listSubagents(middleId)).running).toBe(0);
    expect(harness.service.isConversationRunning(active.childId)).toBe(true);
    // Hidden histories and direct attachment remain available; dismissal is not cancellation.
    expect((await connection.plugins.inspectSubagent(active.childId))?.name).toBe("Live work");
    expect((await connection.client.attach(active.childId)).root.id).toBe(root.id);
    for (const id of listed) await dismiss(id);
    const empty = await connection.client.peer.request(subagentsListRequest, {
      conversationId: root.id,
      limit: 1,
      cursor: null,
    });
    expect(empty).toEqual({ children: [], running: 0, nextCursor: null });
    gate.release();
    expect((await active.done).status).toBe("ok");
    await harness.service.whenIdle(active.childId);
    expect(
      (await connection.client.history({ conversationId: active.childId })).entries.length,
    ).toBeGreaterThan(0);
    unsubscribe();
  } finally {
    await harness.close();
  }
});
