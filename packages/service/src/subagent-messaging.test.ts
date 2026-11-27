import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "@harness/store";
import {
  FakeProvider,
  GateProvider,
  GateTool,
  textStep,
  toolStep,
  unusedCodeEvaluator,
} from "@harness/testkit";
import { z } from "zod";
import {
  ActivityKillTool,
  ActivityPeekTool,
  activitiesOf,
  activitiesPlugin,
  type ActivityResult,
} from "@harness/activities";
import {
  SubagentsDefinition,
  SubagentTool,
  SubagentListTool,
  SubagentSendTool,
  SubagentDismissTool,
} from "@harness/subagents";
import {
  textOf,
  okResult,
  type Tool,
  type ConversationId,
  type ModelProvider,
  type ToolContext,
} from "@harness/protocol";
import { HarnessService } from "./service.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(
  tools: Tool[] = [],
  fallback: Pick<ModelProvider, "stream"> = {
    stream: () => new FakeProvider([textStep("Finished")]).stream(),
  },
) {
  const home = await mkdtemp(join(tmpdir(), "harness-subagent-messages-"));
  const store = new InMemoryStore();
  const provider: ModelProvider = new FakeProvider([]);
  const routes = new Map<ConversationId, Pick<ModelProvider, "stream">>();
  provider.stream = (request, signal, context) =>
    (routes.get(context.conversationId) ?? fallback).stream(request, signal, context);
  const subagents = new SubagentsDefinition();
  const service = new HarnessService({
    store,
    home,
    codeEvaluator: unusedCodeEvaluator,
    plugins: [
      { id: "fake", providers: () => [provider], tools: () => tools },
      activitiesPlugin,
      subagents,
    ],
    defaults: { model: { provider: "fake", model: "fake-1" } },
  });
  subagents.bindRunner(service);
  const root = await service.createConversation({});
  await service.prepare(root.id);
  let calls = 0;
  const context = (id: ConversationId) =>
    ({
      conversationId: id,
      callId: `call-${++calls}`,
      signal: new AbortController().signal,
      service: (key: string) => service.service(id, key),
      emit: () => {},
    }) as unknown as ToolContext;
  const spawn = new SubagentTool({
    runner: () => service,
    registry: subagents.registry,
    reader: {
      get: async () => ({
        agents: [{ name: "general", description: "test", systemPrompt: "test" }],
        maxDepth: 2,
        maxChildren: 3,
      }),
    } as never,
  });
  const create = async (parent: ConversationId, slug: string, name = slug) => {
    const result = await spawn.execute(
      { agent: "general", name, slug, task: slug },
      context(parent),
    );
    expect(result.status).toBe("ok");
    const id = (await service.getPluginState(
      "subagents",
      parent,
      `slug:${slug}`,
    )) as ConversationId;
    expect(result.structured).toEqual({ childId: id, name, slug });
    await service.whenIdle(id);
    return id;
  };
  cleanups.push(async () => {
    await service.deactivateSession(root.id, { force: true });
    await rm(home, { recursive: true, force: true });
  });
  return {
    service,
    store,
    root,
    spawn,
    create,
    context,
    routes,
    list: new SubagentListTool(() => service),
    send: new SubagentSendTool(() => service),
    dismiss: new SubagentDismissTool(() => service),
  };
}

it("bounds each parent's roster and depth, serializes parallel admission, and frees a slot by recursive dismissal", async () => {
  const f = await setup();
  const parent = f.root.id;
  const admission = await Promise.all(
    ["one", "two", "three", "four"].map(async (slug) => ({
      slug,
      result: await f.spawn.execute(
        { agent: "general", name: slug, slug, task: slug },
        f.context(parent),
      ),
    })),
  );
  expect(admission.filter(({ result }) => result.status === "ok")).toHaveLength(3);
  expect(admission.filter(({ result }) => result.status === "error")).toHaveLength(1);
  const children = await Promise.all(
    admission
      .filter(({ result }) => result.status === "ok")
      .map(async ({ slug }) => {
        const id = (await f.service.getPluginState(
          "subagents",
          parent,
          `slug:${slug}`,
        )) as ConversationId;
        await f.service.whenIdle(id);
        return id;
      }),
  );
  const full = await f.spawn.execute(
    { agent: "general", name: "four", slug: "four", task: "four" },
    f.context(parent),
  );
  expect(full.status).toBe("error");
  expect(textOf(full.forModel)).toContain("3 active children");
  const nested = await f.create(children[0]!, "nested");
  await f.create(children[0]!, "nested-two");
  await f.create(children[0]!, "nested-three");
  expect(
    (
      await f.spawn.execute(
        { agent: "general", name: "nested-four", slug: "nested-four", task: "test" },
        f.context(children[0]!),
      )
    ).status,
  ).toBe("error");
  const deep = await f.spawn.execute(
    { agent: "general", name: "deep", slug: "deep", task: "deep" },
    f.context(nested),
  );
  expect(textOf(deep.forModel)).toContain("depth limit");
  await f.dismiss.execute({ to: children[0]! }, f.context(parent));
  const roster = await f.list.execute({ relation: "children" }, f.context(parent));
  expect(textOf(roster.forModel)).not.toContain(children[0]);
  expect(
    (await f.list.execute({ relation: "children" }, f.context(children[0]!))).structured,
  ).toEqual({ agents: [], nextCursor: null });
  await f.create(parent, "replacement");
});

it("wakes finished family members but never wakes closed recipients, including direct parents", async () => {
  const f = await setup();
  const child = await f.create(f.root.id, "child");
  const sibling = await f.create(f.root.id, "sibling");
  const nested = await f.create(child, "nested");
  expect(
    (await f.send.execute({ to: sibling, message: "Review this" }, f.context(child))).status,
  ).toBe("ok");
  await f.service.whenIdle(sibling);
  const input = (await f.store.listActiveItems(sibling)).find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      textOf(item.content).includes("Review this"),
  );
  expect(input).toMatchObject({ source: { kind: "plugin", pluginId: "subagent_send" } });
  expect(input && input.type === "message" && textOf(input.content)).toContain(
    "Message from child:",
  );
  const outsider = await f.service.createConversation({});
  expect((await f.send.execute({ to: outsider.id, message: "No" }, f.context(child))).status).toBe(
    "error",
  );
  await f.dismiss.execute({ to: child }, f.context(f.root.id));
  expect((await f.send.execute({ to: nested, message: "No" }, f.context(child))).status).toBe(
    "error",
  );
  expect(
    (await f.send.execute({ to: child, message: "Report upward" }, f.context(nested))).status,
  ).toBe("error");
  expect(
    (await f.list.execute({ relation: "parent" }, f.context(nested))).structured,
  ).toMatchObject({ agents: [{ id: child }] });
  await expect(
    f.service.deliver(
      nested,
      {
        source: { kind: "plugin", pluginId: "bash" },
        content: [{ type: "text", text: "Activity finished" }],
      },
      "steer",
    ),
  ).rejects.toThrow(/closed/i);
  await f.service.whenIdle(nested);
  expect((await f.store.getLatestTurn(nested))?.status).toBe("completed");
  expect(
    (await f.list.execute({ relation: "children" }, f.context(f.root.id))).structured,
  ).toMatchObject({ agents: [{ id: sibling }] });
});

it("automatically returns each child's full final output once to its parent, not to the sender of a follow-up", async () => {
  const first = `Initial report\n${"detail\n".repeat(3_000)}End of initial report`;
  const second = `Follow-up report\n${"finding\n".repeat(3_000)}End of follow-up report`;
  const gate = new GateTool({ honorSignal: true });
  const f = await setup([gate], new FakeProvider([textStep(first), textStep("Sibling ready")]));
  const root = f.root.id;
  f.routes.set(
    root,
    new FakeProvider([
      toolStep("hold", "gate", {}),
      textStep("Handled while busy"),
      textStep("Sibling ready acknowledged"),
      textStep("Handled while idle"),
    ]),
  );
  const reports = async (owner: ConversationId) =>
    (await f.store.listActiveItems(owner)).flatMap((item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.source?.kind === "plugin" &&
      item.source.pluginId === "subagents"
        ? [{ text: textOf(item.content), turn: item.turnId }]
        : [],
    );
  await f.service.deliver(root, "Start parent work", "send");
  await gate.started;
  const busy = (await f.store.getLatestTurn(root))!.id;
  const child = await f.create(root, "review");
  await vi.waitFor(() =>
    expect(
      f.service.conversationTreeState(root).find((row) => row.conversation.id === root)
        ?.pendingInput,
    ).not.toHaveLength(0),
  );
  gate.release();
  await f.service.whenIdle(root);
  const initial = await reports(root);
  expect(initial.map(({ turn }) => turn)).toEqual([busy]);
  expect(initial[0]!.text).toContain(first);

  const sibling = await f.create(root, "sibling");
  await vi.waitFor(async () => expect(await reports(root)).toHaveLength(2));
  await f.service.whenIdle(root);
  const output = new GateProvider(second);
  f.routes.set(child, output);
  const admission = await f.send.execute({ to: child, message: "Follow up" }, f.context(sibling));
  expect(admission.status).toBe("ok");
  expect(textOf(admission.forModel)).not.toContain(second);
  await output.started;
  expect(await reports(root)).toHaveLength(2);
  output.release();
  await f.service.whenIdle(child);
  await vi.waitFor(async () => expect(await reports(root)).toHaveLength(3));
  await f.service.whenIdle(root);
  const received = await reports(root);
  expect(received.filter(({ text }) => text.includes(first))).toHaveLength(1);
  expect(received.filter(({ text }) => text.includes(second)).map(({ turn }) => turn)).toEqual([
    (await f.store.getLatestTurn(root))!.id,
  ]);
  expect(received.at(-1)!.turn).not.toBe(busy);
  expect(await reports(sibling)).toEqual([]);
});

it("tracks turns, not deliveries: steering joins a busy turn, queued input and reactivation each start another", async () => {
  const gate = new GateTool({ honorSignal: true });
  const f = await setup([gate]);
  const child = await f.create(f.root.id, "child");
  const provider = new FakeProvider([
    toolStep("gate", "gate", {}),
    textStep("Used steering"),
    textStep("Processed queued input"),
  ]);
  f.routes.set(child, provider);
  await f.service.deliver(child, "Work", "send");
  await gate.started;
  const manager = activitiesOf(f.context(f.root.id));
  const activeIds = () =>
    manager
      .list()
      .filter((activity) => !manager.resultOf(activity.id))
      .map((activity) => activity.id);
  const run = activeIds();
  expect(run).toHaveLength(1);
  const busyTurn = (await f.store.getLatestTurn(child))!.id;
  await f.send.execute({ to: child, message: "Steering context" }, f.context(f.root.id));
  await f.service.deliver(child, "Queued context", "queue");
  expect(activeIds()).toEqual(run);
  expect(f.service.isConversationRunning(child)).toBe(true);
  gate.release();
  await f.service.whenIdle(child);
  const items = await f.store.listActiveItems(child);
  const turnFor = (marker: string) =>
    items.find(
      (item) =>
        item.type === "message" && item.role === "user" && textOf(item.content).includes(marker),
    )?.turnId;
  expect(turnFor("Steering context")).toBe(busyTurn);
  const queuedTurn = (await f.store.getLatestTurn(child))!.id;
  expect(queuedTurn).not.toBe(busyTurn);
  expect(turnFor("Queued context")).toBe(queuedTurn);
  expect(manager.list()).toHaveLength(3); // spawn, busy turn, queued turn
  await f.service.deactivateSession(f.root.id, { force: true });
  await f.service.prepare(f.root.id);
  const resumed = new GateProvider("Resumed");
  f.routes.set(child, resumed);
  await f.send.execute({ to: child, message: "Wake again" }, f.context(f.root.id));
  await resumed.started;
  expect(f.service.rootConversationOf(child)).toBe(f.root.id);
  await f.service.deactivateSession(f.root.id, { force: true });
  expect(f.service.conversationTreeState(f.root.id)).toEqual([]);
});

it.each([false, true])(
  "tracks each child turn under its parent; killing it preserves queued input, descendants and later messages (reload: %s)",
  async (reload) => {
    const f = await setup();
    const root = f.root.id;
    const child = await f.create(root, "review");
    const manager = (owner: ConversationId) => activitiesOf(f.context(owner));
    const original = manager(root).list();
    expect(original).toHaveLength(1);
    const originalId = original[0]!.id;
    const sibling = await f.create(root, "sibling");
    const nested = await f.create(child, "nested");
    if (reload) {
      await f.service.deactivateSession(root);
      await f.service.prepare(root);
    }
    const wake = async (sender: ConversationId, recipient: ConversationId, message: string) => {
      expect((await f.send.execute({ to: recipient, message }, f.context(sender))).status).toBe(
        "ok",
      );
    };
    if (reload) {
      await wake(root, sibling, "Resume the sibling");
      await f.service.whenIdle(sibling);
    }
    const live = (owner: ConversationId) =>
      manager(owner)
        .list()
        .filter((a) => !manager(owner).resultOf(a.id));
    const nestedGate = new GateProvider("Nested is working");
    f.routes.set(nested, nestedGate);
    await wake(child, nested, "Wake nested worker");
    await nestedGate.started;
    expect(live(child)).toHaveLength(1);
    const nestedRun = live(child)[0]!;

    const busy = new GateProvider("Reviewing");
    f.routes.set(child, busy);
    await wake(sibling, child, "Wake review");
    await busy.started;
    expect(live(root)).toHaveLength(1);
    const run = live(root)[0]!;
    expect(run.id).not.toBe(originalId);
    await wake(sibling, child, "Queued sibling input");
    expect(live(root).map((a) => a.id)).toEqual([run.id]);
    const kill = (owner: ConversationId, id: string) =>
      new ActivityKillTool().execute({ id }, f.context(owner));
    expect((await kill(root, originalId)).status).toBe("error");
    expect((await kill(root, child)).status).toBe("error");
    expect((await kill(sibling, run.id)).status).toBe("error");
    expect((await kill(root, nestedRun.id)).status).toBe("error");
    expect(f.service.isConversationRunning(child)).toBe(true);

    const queued = new GateProvider("Processing queued input");
    f.routes.set(child, queued);
    f.routes.set(root, {
      stream: () => {
        f.routes.delete(root);
        return new FakeProvider([toolStep("stop-run", "activity_kill", { id: run.id })]).stream();
      },
    });
    await f.service.deliver(root, "Stop the active review", "send");
    await f.service.whenIdle(root);
    expect(
      (await f.store.listActiveItems(root)).find(
        (item) => item.type === "tool_result" && item.callId === "stop-run",
      ),
    ).toMatchObject({ status: "ok" });
    expect((await run.done).status).toBe("error");
    await queued.started;
    expect(live(root)).toHaveLength(1);
    const next = live(root)[0]!;
    expect(next.id).not.toBe(run.id);
    expect((await kill(root, run.id)).status).toBe("error");
    expect(f.service.isConversationRunning(child)).toBe(true);
    expect(f.service.isConversationRunning(nested)).toBe(true);
    queued.release();
    nestedGate.release();
    expect((await next.done).status).toBe("ok");
    expect((await nestedRun.done).status).toBe("ok");
    await f.service.whenIdle(child);
    expect(
      (await f.store.listActiveItems(child)).filter(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          textOf(item.content).includes("Queued sibling input"),
      ),
    ).toHaveLength(1);
    const later = new GateProvider("Later review");
    f.routes.set(child, later);
    await wake(sibling, child, "Another independent review");
    await later.started;
    expect(live(root)).toHaveLength(1);
    expect(live(root)[0]!.id).not.toBe(next.id);
    later.release();
    await f.service.whenIdle(child);
  },
);

it("dismissal aborts the active subtree and discards pending input instead of starting another turn", async () => {
  const f = await setup();
  const root = f.root.id;
  const child = await f.create(root, "child");
  const nested = await f.create(child, "nested");
  const sibling = await f.create(root, "sibling");
  const atDismissal = new Map<ConversationId, string>();
  for (const target of [nested, child]) {
    const gate = new GateProvider("Held work");
    f.routes.set(target, gate);
    await f.service.deliver(target, "Work", "send");
    await gate.started;
    atDismissal.set(target, (await f.store.getLatestTurn(target))!.id);
  }
  expect(
    (await f.send.execute({ to: child, message: "Pending sibling input" }, f.context(sibling)))
      .status,
  ).toBe("ok");
  expect(
    f.service
      .conversationTreeState(root)
      .find((row) => row.conversation.id === child)
      ?.pendingInput.map((input) => input.text),
  ).toEqual([expect.stringContaining("Pending sibling input")]);
  expect((await f.dismiss.execute({ to: "child" }, f.context(root))).status).toBe("ok");
  for (const id of [child, nested]) {
    await f.service.whenIdle(id);
    expect(await f.store.getConversation(id)).toMatchObject({ closed: true });
    expect(await f.store.getLatestTurn(id)).toMatchObject({
      id: atDismissal.get(id),
      status: "aborted",
    });
    await expect(f.service.deliver(id, "Wake again", "send")).rejects.toThrow(/closed/i);
  }
  expect(
    (await f.store.listActiveItems(child)).some(
      (item) => item.type === "message" && textOf(item.content).includes("Pending sibling input"),
    ),
  ).toBe(false);
  expect(
    (await f.list.execute({ relation: "children" }, f.context(root))).structured,
  ).toMatchObject({
    agents: [{ id: sibling }],
  });
});

it.each([false, true])(
  "background completion starts a new child activity only while its thread is open (dismiss: %s)",
  async (dismiss) => {
    let finish!: (result: ActivityResult) => void;
    const done = new Promise<ActivityResult>((resolve) => {
      finish = resolve;
    });
    const killed = vi.fn(() => finish({ status: "error", summary: "Stopped", view: [] }));
    const tool: Tool = {
      essential: true,
      name: "background_test",
      description: "Controlled background activity",
      meta: { backgroundable: true },
      input: { kind: "function", schema: z.strictObject({}) },
      execute: async (_args, ctx) => {
        activitiesOf(ctx).track(
          {
            id: "background",
            kind: "test",
            title: "Controlled work",
            done,
            peek: () => [],
            kill: killed,
          },
          { callId: ctx.callId, emit: (event) => ctx.emit(event) },
        );
        return okResult("Started");
      },
    };
    const f = await setup([tool]);
    const child = await f.create(f.root.id, "child");
    const continuation = new FakeProvider([
      toolStep("list", "subagent_list", { relation: "parent" }),
      toolStep("background", "background_test", { background: true }),
      textStep("Submitted"),
    ]);
    f.routes.set(child, continuation);
    await f.service.deliver(child, "Start background work", "send");
    await f.service.whenIdle(child);
    expect(
      (await f.store.listActiveItems(child)).some(
        (item) => item.type === "tool_result" && item.callId === "list" && item.status === "ok",
      ),
    ).toBe(true);
    if (!dismiss) {
      const manager = activitiesOf(f.context(f.root.id));
      const prior = new Set(manager.list().map((activity) => activity.id));
      const completion = new GateProvider("Finished background work");
      f.routes.set(child, completion);
      finish({ status: "ok", summary: "Done", view: [] });
      await completion.started;
      const fresh = manager.list().filter((activity) => !prior.has(activity.id));
      expect(fresh).toHaveLength(1);
      expect(manager.resultOf(fresh[0]!.id)).toBeUndefined();
      completion.release();
      expect((await fresh[0]!.done).status).toBe("ok");
      return;
    }
    await f.dismiss.execute({ to: child }, f.context(f.root.id));
    expect(killed).toHaveBeenCalledOnce();
    await f.service.whenIdle(child);
    expect(
      (await f.store.listActiveItems(child)).some(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          item.source?.kind === "plugin" &&
          textOf(item.content).includes("Stopped"),
      ),
    ).toBe(false);
  },
);

it("briefs projectless children and grandchildren truthfully with their own identity, parent and task", async () => {
  const f = await setup();
  await f.service.setTitle(f.root.id, "Root work");
  const child = await f.create(f.root.id, "review", "Review changes");
  const nested = await f.create(child, "tests", "Check tests");
  for (const [id, expected] of [
    [child, ["Review changes [review]", "Root work (parent)", "Assigned task:\nreview"]],
    [nested, ["Check tests [tests]", "Review changes [review]", "Assigned task:\ntests"]],
  ] as const) {
    const first = (await f.store.listActiveItems(id)).find(
      (item) => item.type === "message" && item.role === "user",
    );
    expect(first?.type).toBe("message");
    const text = first?.type === "message" ? textOf(first.content) : "";
    for (const part of expected) expect(text).toContain(part);
    expect(text).not.toContain(id);
    expect(text).not.toContain(f.root.id);
    expect(text).toContain("using the general profile");
  }
});

it("resolves readable family references, rejects ambiguity, scopes dismissal to children, and retains legacy/canonical authorization", async () => {
  const f = await setup();
  const child = await f.create(f.root.id, "review", "Review changes");
  const sibling = await f.create(f.root.id, "tests", "Same name");
  const duplicate = await f.create(f.root.id, "other", "Same name");
  const nested = await f.create(child, "tests", "Nested task");
  const ordinary = await f.list.execute({ relation: "children" }, f.context(f.root.id));
  for (const canonical of [child, sibling, duplicate])
    expect(textOf(ordinary.forModel)).not.toContain(canonical);
  expect(textOf(ordinary.forModel)).toContain('"reference":"review"');
  expect(
    (ordinary.structured as { agents: { id: string }[] }).agents.some((row) => row.id === child),
  ).toBe(true);
  // This sibling's slug collides with our child and its name with another sibling.
  const ambiguousList = await f.list.execute({ relation: "siblings" }, f.context(child));
  expect(textOf(ambiguousList.forModel)).toContain(sibling);

  // A durable reachable family member does not grant access to its owner's activity manager.
  const peek = new ActivityPeekTool();
  const reviewRun = (await f.store.getLatestTurn(child))!.id;
  expect((await peek.execute({ id: reviewRun }, f.context(f.root.id))).status).toBe("ok");
  expect((await peek.execute({ id: "review" }, f.context(child))).status).toBe("error");
  expect((await peek.execute({ id: child }, f.context(sibling))).status).toBe("error");

  expect(
    (await f.send.execute({ to: "Review changes", message: "Hello" }, f.context(f.root.id))).status,
  ).toBe("ok");
  await f.service.whenIdle(child);
  expect((await f.send.execute({ to: "parent", message: "Upward" }, f.context(child))).status).toBe(
    "ok",
  );
  await f.service.whenIdle(f.root.id);
  expect(
    textOf(
      (await f.send.execute({ to: "Same name", message: "Ambiguous" }, f.context(child))).forModel,
    ),
  ).toContain("Ambiguous");
  // A child and sibling share a slug; send sees both, dismissal sees only direct children.
  expect(
    textOf(
      (await f.send.execute({ to: "tests", message: "Ambiguous" }, f.context(child))).forModel,
    ),
  ).toContain("Ambiguous");
  expect((await f.dismiss.execute({ to: "tests" }, f.context(child))).status).toBe("ok");
  expect(await f.service.getPluginState("subagents", nested, "dismissed")).toBe(true);
  expect(await f.service.getPluginState("subagents", sibling, "dismissed")).toBeUndefined();
  expect(
    (await f.send.execute({ to: duplicate, message: "Canonical" }, f.context(child))).status,
  ).toBe("ok");
  await f.service.whenIdle(duplicate);
  await f.service.putPluginState(
    "subagents",
    sibling,
    "spawn",
    { parent: { conversationId: f.root.id, callId: "legacy" }, agent: "general" },
    f.root.id,
  );
  const roster = await f.list.execute({ relation: "siblings" }, f.context(child));
  const agents = (roster.structured as { agents: { id: string; name: string; slug: string }[] })
    .agents;
  expect(agents.find((member) => member.id === sibling)).toMatchObject({
    id: sibling,
    name: "general",
    slug: sibling,
  });
  expect(
    (await f.send.execute({ to: sibling, message: "Legacy UUID" }, f.context(child))).status,
  ).toBe("ok");
  await f.service.whenIdle(sibling);
  const legacyChild = await f.create(sibling, "legacy-child", "Legacy parent task");
  const seed = (await f.store.listActiveItems(legacyChild)).find(
    (item) => item.type === "message" && item.role === "user",
  );
  expect(seed?.type === "message" ? textOf(seed.content) : "").toContain(
    "Your direct parent is general (parent)",
  );
  await f.service.deactivateSession(f.root.id, { force: true });
  await f.service.prepare(f.root.id);
  expect(
    (await f.send.execute({ to: "review", message: "After reload" }, f.context(f.root.id))).status,
  ).toBe("ok");
  await f.service.whenIdle(child);
  const outsider = await f.service.createConversation({});
  await f.service.setTitle(outsider.id, "Outside");
  expect((await f.send.execute({ to: "Outside", message: "No" }, f.context(child))).status).toBe(
    "error",
  );
  expect((await f.send.execute({ to: outsider.id, message: "No" }, f.context(child))).status).toBe(
    "error",
  );
});
