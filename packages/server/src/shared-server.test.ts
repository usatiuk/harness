import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { SqliteStore } from "@harness/store-sqlite";
import { InMemoryStore } from "@harness/store";
import {
  unusedCodeEvaluator,
  FakeProvider,
  GateProvider,
  GateTool,
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
  subagentsListRequest,
  subagentsEventNotification,
  type SubagentPage,
} from "@harness/subagents";
import {
  isKernelEvent,
  textOf,
  type ConversationId,
  type PluginEntry,
  type ModelProvider,
  type ModelRequest,
  type Store,
} from "@harness/protocol";
import { registerApprovalServer } from "./approvals.ts";
import { registerFeatureServer } from "./features.ts";
import { HarnessPluginClient, FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import {
  ActivityManager,
  activitiesPlugin,
  activityKillRequest,
  isActivityEvent,
} from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { LocalExecutionContext } from "@harness/execution";
import { createProcessActivity } from "@harness/workspace";
import { outputPlugin } from "@harness/output";
import { mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function userInputMatches(request: ModelRequest, matches: (text: string) => boolean) {
  return request.items.some(
    ({ item }) => item.type === "message" && item.role === "user" && matches(textOf(item.content)),
  );
}

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

it("preserves a process tail through activity_peek without unbounding other activities in the batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-peek-"));
  const execution = new LocalExecutionContext(root);
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const provider = new FakeProvider([
    [
      { type: "tool_call", callId: "act_build", name: "activity_peek", args: { id: "act_build" } },
      ...toolStep("review", "activity_peek", { id: "review" }),
    ],
    textStep("done"),
  ]);
  const harness = sharedHarness(
    provider,
    [
      activitiesPlugin,
      outputPlugin,
      { id: "execution", services: () => [{ key: "execution", for: () => execution }] },
    ],
    store,
  );
  let finish!: () => void;
  const exit = new Promise<{ code: number; signal: null }>((resolve) => {
    finish = () => resolve({ code: 0, signal: null });
  });
  try {
    const { id } = await harness.service.createConversation({});
    await harness.service.prepare(id);
    const manager = harness.service.service(id, "activities");
    if (!(manager instanceof ActivityManager)) throw new Error("missing activity manager");
    const tail = [...Array<string>(39).fill("x".repeat(408)), "x".repeat(399) + " ISREADY!"].join(
      "\n",
    );
    const process = createProcessActivity({
      id: "act_build",
      name: "A".repeat(80),
      command: "build",
      shell: execution.shellKind,
      store: execution.outputStore(id),
      proc: { pid: undefined, exit, kill: finish, onData: (send) => send(tail) },
    });
    const log = process.persist!();
    manager.track(process, { emit() {} });
    manager.track(
      {
        id: "review",
        title: "Review",
        reference: "review",
        kind: "subagent",
        peek: () => [{ type: "text", text: "review start" + "x".repeat(20_000) + "review end" }],
        done: Promise.resolve({ status: "ok", summary: "done", view: [] }),
        kill() {},
      },
      { emit() {} },
    );
    await harness.service.send(id, "inspect both activities");
    await harness.service.whenIdle(id);
    const results = (await store.listActiveItems(id)).filter((item) => item.type === "tool_result");
    const content = (id: string) => textOf(results.find((item) => item.callId === id)!.content);
    const build = content("act_build");
    expect(build).toContain(`Log: ${log}\n`);
    expect(build.endsWith(tail)).toBe(true);
    expect(content("review")).toContain("review start");
    expect(content("review")).not.toContain("review end");
    expect(await readdir(join(root, ".harness", id, "outputs"))).toHaveLength(2);
  } finally {
    finish();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

it("saves an interrupted restored grandchild's activity result to its cold direct parent", async () => {
  const store = new InMemoryStore();
  const subagents = new SubagentsDefinition((): HarnessService => harness.service);
  const provider = new FakeProvider([]);
  provider.stream = () => new FakeProvider([textStep("Done")]).stream();
  const harness = sharedHarness(provider, [activitiesPlugin, subagents], store);
  try {
    const { client } = await harness.connect();
    const root = (await client.create({})).id as ConversationId;
    await client.attach(root);
    const historicalChild = async (parent: ConversationId, slug: string) => {
      const { childId } = await subagents.spawn({
        parent,
        callId: slug,
        agent: "general",
        name: slug,
        slug,
        task: slug,
      });
      await harness.service.whenIdle(childId);
      await harness.service.whenIdle(parent);
      return childId;
    };
    const mid = await historicalChild(root, "parent");
    const leaf = await historicalChild(mid, "leaf");
    await harness.service.whenIdle(root);
    await harness.host.deactivate(root, true);
    const initialLeaf = await store.getLatestTurn(leaf);
    const initialParent = await store.getLatestTurn(mid);
    const before = new Set((await store.listActiveItems(mid)).map((item) => item.id));

    await client.attach(leaf);
    let stopping: ReturnType<HarnessRpcHost["deactivate"]> | undefined;
    const off = harness.service.subscribe(leaf, (event) => {
      if (isKernelEvent(event) && event.type === "turn.status" && event.status === "running")
        stopping = harness.host.deactivate(root, true);
    });
    await harness.service.deliver(leaf, "Resume", "send");
    await harness.service.whenIdle(leaf);
    await expect(stopping).resolves.toMatchObject({ status: "deactivated" });
    off();
    const resumed = await store.getLatestTurn(leaf);
    expect(initialLeaf?.status).toBe("completed");
    expect(resumed?.id).not.toBe(initialLeaf!.id);
    expect(resumed?.status).toBe("aborted");
    const notices = (await store.listActiveItems(mid))
      .filter((item) => !before.has(item.id))
      .filter((item) => item.type === "message" && item.role === "user");
    expect(notices).toMatchObject([
      { role: "user", source: { kind: "plugin", pluginId: "subagents" }, turnId: null },
    ]);
    expect(textOf(notices[0]!.content)).toMatch(/aborted/);
    expect((await store.getLatestTurn(mid))?.id).toBe(initialParent!.id);
  } finally {
    await harness.close();
  }
});

it("inspects durable subagent trees over RPC and rejects client mutations without disrupting parent ownership", async () => {
  const gate = new GateProvider("Live child output");
  const provider: ModelProvider = new FakeProvider([]);
  provider.stream = async function* (request, signal) {
    if (userInputMatches(request, (text) => text.endsWith("\nlive")))
      yield* gate.stream(request, signal);
    else if (userInputMatches(request, (text) => text.endsWith("\nfail")))
      throw new Error("Review failed");
    else yield* textStep("Complete");
  };
  const subagents = new SubagentsDefinition((): HarnessService => harness.service);
  const harness = sharedHarness(provider, [activitiesPlugin, subagents]);
  try {
    const first = await harness.connect();
    const root = await first.client.create({});
    await first.client.attach(root.id);
    const child = await subagents.spawn({
      parent: root.id as ConversationId,
      agent: "explore",
      name: "Review authentication",
      slug: "auth-review",
      task: "review",
    });
    await harness.service.whenIdle(child.childId);
    const nested = await subagents.spawn({
      parent: child.childId,
      agent: "general",
      name: "Check tests",
      slug: "tests",
      task: "check",
    });
    await harness.service.whenIdle(nested.childId);
    const failed = await subagents.spawn({
      parent: root.id as ConversationId,
      agent: "explore",
      name: "Failed review",
      slug: "failed",
      task: "fail",
    });
    await harness.service.whenIdle(failed.childId);
    const active = await subagents.spawn({
      parent: child.childId,
      agent: "explore",
      name: "Live review",
      slug: "live",
      task: "live",
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
    harness.service.interruptTurn(
      active.childId,
      (await harness.service.getLatestTurn(active.childId))!.id,
    );
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

it("exposes distinct activity IDs for resumed turns and stops only the live owner's run over RPC", async () => {
  const launcher = new FakeProvider([
    toolStep("spawn", "subagent", {
      agent: "general",
      name: "Review",
      slug: "review",
      task: "Review",
    }),
    textStep("Delegate done"),
  ]);
  const report = "Evidence from the child. ".repeat(80) + "End of full report.";
  const firstRun = new GateProvider(report);
  const provider: ModelProvider = new FakeProvider([]);
  const subagents = new SubagentsDefinition((): HarnessService => harness.service);
  const harness = sharedHarness(provider, [activitiesPlugin, subagents]);
  const gate = new GateProvider("Resumed work");
  try {
    const { client, plugins } = await harness.connect();
    const owner = (await client.create({})).id as ConversationId;
    const sender = new FakeProvider([
      toolStep("send", "subagent_send", { to: "review", message: "Resume" }),
      textStep("Message accepted"),
    ]);
    provider.stream = async function* (request, signal) {
      const parent = request.items.some(
        ({ item }) => "conversationId" in item && item.conversationId === owner,
      );
      const lastInput = request.items.findLast(
        ({ item }) => item.type === "message" && item.role === "user",
      )?.item;
      const fromPlugin =
        lastInput?.type === "message" &&
        "source" in lastInput &&
        lastInput.source?.kind === "plugin";
      if (parent) {
        if (fromPlugin) yield* textStep("Received report");
        else if (userInputMatches(request, (text) => text === "Send more work"))
          yield* sender.stream();
        else yield* launcher.stream();
      } else if (fromPlugin) yield* gate.stream(request, signal);
      else yield* firstRun.stream(request, signal);
    };
    const outsider = (await client.create({})).id as ConversationId;
    await client.attach(owner);
    await client.attach(outsider);
    const runs: string[] = [];
    plugins.subscribe(owner, (event) => {
      if (
        isActivityEvent(event) &&
        event.type === "activity.started" &&
        event.kind === "subagent" &&
        event.conversationId === owner
      )
        runs.push(event.id);
    });
    await client.deliver(owner, "Delegate", "send");
    await firstRun.started;
    await harness.service.whenIdle(owner);
    const child = (await plugins.listSubagents(owner)).children[0]!.id as ConversationId;
    expect(harness.service.isConversationRunning(child)).toBe(true);
    const delegatedTurn = await harness.service.getLatestTurn(owner);
    expect(delegatedTurn?.status).toBe("completed");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    firstRun.release();
    await harness.service.whenIdle(child);
    await vi.waitFor(async () => {
      const { entries } = await client.history({ conversationId: owner });
      const reports = entries.flatMap((entry) =>
        entry.kind === "item" &&
        entry.item.type === "message" &&
        entry.item.role === "user" &&
        entry.item.source?.kind === "plugin" &&
        entry.item.source.pluginId === "subagents"
          ? [textOf(entry.item.content)]
          : [],
      );
      expect(reports).toEqual([expect.stringContaining(report)]);
    });
    await harness.service.whenIdle(owner);
    const awakened = await harness.service.getLatestTurn(owner);
    expect(awakened?.status).toBe("completed");
    expect(awakened?.id).not.toBe(delegatedTurn!.id);
    await client.deliver(owner, "Send more work", "send");
    await gate.started;
    // The sender finishes its tool call without waiting for the gated recipient.
    await harness.service.whenIdle(owner);
    expect(await harness.service.getItems(owner)).toContainEqual(
      expect.objectContaining({ type: "tool_result", callId: "send", status: "ok" }),
    );
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    const [original, current] = runs as [string, string];
    expect(current).not.toBe(original);
    const kill = (conversationId: ConversationId, activityId: string) =>
      client.peer.request(activityKillRequest, { conversationId, activityId });
    expect((await kill(outsider, current)).status).toBe("unknown");
    expect((await kill(owner, original)).status).toBe("settled");
    expect(harness.service.isConversationRunning(child)).toBe(true);
    expect((await kill(owner, current)).status).toBe("requested");
    await harness.service.whenIdle(child);
    expect((await plugins.listSubagents(owner)).children).toContainEqual(
      expect.objectContaining({ id: child, status: "aborted" }),
    );
    expect((await kill(owner, current)).status).toBe("settled");
  } finally {
    firstRun.release();
    gate.release();
    await harness.close();
  }
});

it("preserves sibling input in order through host shutdown and SQLite reopen without calling the model again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-shutdown-siblings-"));
  const path = join(dir, "history.db");
  const heldTool = new GateTool({ honorSignal: true });
  const senderWorking = new GateProvider("Work in progress");
  let recipient: ConversationId | undefined;
  let report!: () => void;
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = new FakeProvider([]);
  provider.stream = async function* (request, signal) {
    calls.push(request);
    if (userInputMatches(request, (text) => text === "Use both findings")) {
      yield* textStep("Reviewed both findings");
    } else if (userInputMatches(request, (text) => text.endsWith("\nReceive"))) {
      yield* toolStep("hold-recipient", heldTool.name, {});
    } else if (userInputMatches(request, (text) => text.endsWith("\nSend"))) {
      if (!request.items.some(({ item }) => item.type === "tool_result" && item.callId === "send"))
        yield* toolStep("send", "subagent_send", { to: recipient!, message: "First finding" });
      else {
        signal.addEventListener("abort", report, { once: true });
        try {
          yield* senderWorking.stream(request, signal);
        } finally {
          signal.removeEventListener("abort", report);
        }
      }
    } else yield* textStep("Handled");
  };
  const subagents = new SubagentsDefinition((): HarnessService => harness.service);
  const store = new SqliteStore(path);
  const harness = sharedHarness(
    provider,
    [
      activitiesPlugin,
      subagents,
      {
        id: "field-notes",
        tools: () => [heldTool],
        async onTurnStart({ conversation }) {
          if (!recipient || conversation.id === recipient || !conversation.parentId) return;
          const target = await harness.service.scope(recipient, this.id);
          report = () => target.deliver([{ type: "text", text: "Second finding" }]);
        },
      },
    ],
    store,
  );
  try {
    try {
      const { client } = await harness.connect();
      const parent = (await client.create({})).id as ConversationId;
      await client.attach(parent);
      const spawn = (task: string) =>
        subagents.spawn({
          parent,
          agent: "general",
          name: task,
          slug: task.toLowerCase(),
          task,
        });
      recipient = (await spawn("Receive")).childId;
      await heldTool.started;
      const sender = (await spawn("Send")).childId;
      await senderWorking.started;
      expect(await harness.service.getItems(sender)).toContainEqual(
        expect.objectContaining({ type: "tool_result", callId: "send", status: "ok" }),
      );
      const pending = harness.service
        .conversationTreeState(parent)
        .find((member) => member.conversation.id === recipient)?.pendingInput;
      expect(pending).toMatchObject([
        { intent: "steer", source: { kind: "plugin", pluginId: "subagent_send" } },
      ]);
      const before = calls.length;
      // Stops RPC admission, cancels active family work, then retires the root.
      await harness.close();
      expect(calls).toHaveLength(before);
    } finally {
      heldTool.release();
      senderWorking.release();
      try {
        await harness.close();
      } finally {
        store.close();
      }
    }
    const reopened = new SqliteStore(path);
    const after = sharedHarness(provider, [], reopened);
    try {
      const before = calls.length;
      const { client } = await after.connect();
      await client.attach(recipient);
      await after.service.whenIdle(recipient);
      const { entries } = await client.history({ conversationId: recipient });
      // History pages walk from head toward its ancestors.
      const ordered = entries.toReversed().flatMap((entry) => {
        if (entry.kind !== "item") return [];
        const item = entry.item;
        if (item.type === "tool_result" && item.callId === "hold-recipient")
          return [`tool:${item.status}`];
        if (item.type === "message" && item.role === "user" && item.source?.kind === "plugin")
          return [`${item.source.pluginId}:${textOf(item.content)}`];
        return [];
      });
      expect(ordered).toEqual([
        "tool:error",
        expect.stringMatching(/^subagent_send:.*First finding$/s),
        "field-notes:Second finding",
      ]);
      expect(calls).toHaveLength(before);
      await after.service.deliver(recipient, "Use both findings", "send");
      await after.service.whenIdle(recipient);
      expect(calls).toHaveLength(before + 1);
      const inputs = calls
        .at(-1)!
        .items.flatMap(({ item }) =>
          item.type === "message" && item.role === "user" ? [textOf(item.content)] : [],
        );
      expect(inputs).toEqual([
        expect.stringContaining("Receive"),
        expect.stringContaining("First finding"),
        "Second finding",
        "Use both findings",
      ]);
    } finally {
      try {
        await after.close();
      } finally {
        reopened.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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

it("closes live descendants on dismissal, filters branches before paging and publishes scoped GUI changes", async () => {
  const provider: ModelProvider = new FakeProvider([]);
  const gate = new GateProvider("Nested work");
  provider.stream = async function* (request, signal) {
    const lastInput = request.items.findLast(
      ({ item }) => item.type === "message" && item.role === "user",
    )?.item;
    const command = lastInput?.type === "message" ? textOf(lastInput.content) : "";
    const prefix = "Dismiss task ";
    if (command.startsWith(prefix)) {
      const to = command.slice(prefix.length);
      const callId = `dismiss-${to}`;
      if (
        !request.items.some(({ item }) => item.type === "tool_result" && item.callId === callId)
      ) {
        yield* toolStep(callId, "subagent_dismiss", { to });
        return;
      }
    }
    if (userInputMatches(request, (text) => text.endsWith("\nWait")))
      yield* gate.stream(request, signal);
    else yield* textStep("Finished");
  };
  const subagents = new SubagentsDefinition((): HarnessService => harness.service);
  const harness = sharedHarness(provider, [activitiesPlugin, subagents]);
  try {
    const connection = await harness.connect();
    const root = await connection.client.create({
      overrides: { plugins: { subagents: { maxChildren: 5 } } },
    });
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
      const child = await subagents.spawn({
        parent: root.id as ConversationId,
        agent: "general",
        name: `Task ${i}`,
        slug: `task-${i}`,
        task: "Work",
      });
      await harness.service.whenIdle(child.childId);
    }
    const initial = await connection.plugins.listSubagents(root.id as ConversationId);
    expect(initial.children).toHaveLength(5);
    const firstId = initial.children[0]!.id as ConversationId;
    const middleId = initial.children[2]!.id as ConversationId;
    // A retained parent's only dismissed child must not leave a stale expander.
    const retainedId = initial.children[1]!.id as ConversationId;
    const finished = await subagents.spawn({
      parent: retainedId,
      agent: "general",
      name: "Finished nested",
      slug: "finished",
      task: "Work",
    });
    await harness.service.whenIdle(finished.childId);
    expect(
      (await connection.plugins.listSubagents(root.id as ConversationId)).children.find(
        (row) => row.id === retainedId,
      )?.hasChildren,
    ).toBe(true);
    await harness.service.putPluginState("subagents", finished.childId, "dismissed", true);
    const active = await subagents.spawn({
      parent: middleId,
      agent: "general",
      name: "Live work",
      slug: "live",
      task: "Wait",
    });
    await gate.started;
    expect((await connection.plugins.listSubagents(root.id as ConversationId)).running).toBe(1);
    const events: unknown[] = [];
    const unsubscribe = connection.plugins.subscribe(root.id as ConversationId, (event) => {
      if (event.type === "subagents.changed") events.push(event);
    });
    const dismiss = async (to: string) => {
      await harness.service.deliver(root.id as ConversationId, `Dismiss task ${to}`, "send");
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
    expect(harness.service.isConversationRunning(active.childId)).toBe(false);
    // Closed branches can still be inspected and attached read-only.
    expect((await connection.plugins.inspectSubagent(active.childId))?.name).toBe("Live work");
    const closedBranch = await connection.client.attach(active.childId);
    expect(closedBranch.root.id).toBe(root.id);
    const inspected = closedBranch.members.map((member) => member.conversation.id);
    expect(inspected).toEqual(expect.arrayContaining([middleId, active.childId]));
    const live = harness.service.conversationTreeState(root.id as ConversationId);
    expect(
      live.some(({ conversation }) => [middleId, active.childId].includes(conversation.id)),
    ).toBe(false);
    await expect(connection.client.deliver(active.childId, "Resume", "send")).rejects.toThrow(
      "read-only",
    );
    for (const id of listed) await dismiss(id);
    const empty = await connection.client.peer.request(subagentsListRequest, {
      conversationId: root.id,
      limit: 1,
      cursor: null,
    });
    expect(empty).toEqual({ children: [], running: 0, nextCursor: null });
    gate.release();
    await harness.service.whenIdle(active.childId);
    expect((await harness.service.getLatestTurn(active.childId))?.status).toBe("aborted");
    expect(
      (await connection.client.history({ conversationId: active.childId })).entries.length,
    ).toBeGreaterThan(0);
    unsubscribe();
  } finally {
    await harness.close();
  }
});
