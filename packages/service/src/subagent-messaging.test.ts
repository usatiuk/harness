import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "@harness/store";
import {
  FakeProvider,
  GateProvider,
  textStep,
  toolStep,
  unusedCodeEvaluator,
} from "@harness/testkit";
import { z } from "zod";
import {
  ActivityManager,
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
async function setup(tools: Tool[] = []) {
  const home = await mkdtemp(join(tmpdir(), "harness-subagent-messages-"));
  const store = new InMemoryStore();
  const provider: ModelProvider = new FakeProvider(
    Array.from({ length: 30 }, () => textStep("Finished")),
  );
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
  const managers = new Map<ConversationId, ActivityManager>();
  let calls = 0;
  const context = (id: ConversationId) => {
    if (!managers.has(id)) managers.set(id, new ActivityManager(id));
    return {
      conversationId: id,
      callId: `call-${++calls}`,
      signal: new AbortController().signal,
      service: () => managers.get(id),
      emit: () => {},
    } as unknown as ToolContext;
  };
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
    await service.whenIdle(id);
    return id;
  };
  cleanups.push(async () => {
    await service.deactivateSession(root.id, { force: true });
    for (const manager of managers.values()) await manager.dispose();
    await rm(home, { recursive: true, force: true });
  });
  return {
    service,
    store,
    root,
    spawn,
    create,
    context,
    provider,
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

it("uses ordinary plugin delivery to wake finished family members, while dismissed branches can still message their parent", async () => {
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
  ).toBe("ok");
  await f.service.whenIdle(child);
  expect(
    (await f.list.execute({ relation: "parent" }, f.context(nested))).structured,
  ).toMatchObject({ agents: [{ id: child }] });
  // Completion callbacks use this same plugin-input seam; dismissal does not block them.
  await f.service.deliver(
    nested,
    {
      source: { kind: "plugin", pluginId: "bash" },
      content: [{ type: "text", text: "Activity finished" }],
    },
    "steer",
  );
  await f.service.whenIdle(nested);
  expect((await f.store.getLatestTurn(nested))?.status).toBe("completed");
  expect(
    (await f.list.execute({ relation: "children" }, f.context(f.root.id))).structured,
  ).toMatchObject({ agents: [{ id: sibling }] });
});

it("queues into busy recipients without interrupting them and preserves ownership when waking a historical child", async () => {
  const f = await setup();
  const child = await f.create(f.root.id, "child");
  const gate = new GateProvider("Finished busy work");
  f.provider.stream = gate.stream.bind(gate);
  await f.service.deliver(child, "Work", "send");
  await gate.started;
  await f.send.execute({ to: child, message: "Extra context" }, f.context(f.root.id));
  expect(f.service.isConversationRunning(child)).toBe(true);
  gate.release();
  await f.service.whenIdle(child);
  expect(
    (await f.store.listActiveItems(child)).some(
      (item) => item.type === "message" && textOf(item.content).includes("Extra context"),
    ),
  ).toBe(true);
  await f.service.deactivateSession(f.root.id, { force: true });
  await f.service.prepare(f.root.id);
  const resumed = new GateProvider("Resumed");
  f.provider.stream = resumed.stream.bind(resumed);
  await f.send.execute({ to: child, message: "Wake again" }, f.context(f.root.id));
  await resumed.started;
  expect(f.service.rootConversationOf(child)).toBe(f.root.id);
  await f.service.deactivateSession(f.root.id, { force: true });
  expect(f.service.conversationTreeState(f.root.id)).toEqual([]);
});

it("real background completion wakes a dismissed finished subagent through its captured tool context", async () => {
  let finish!: (result: ActivityResult) => void;
  const done = new Promise<ActivityResult>((resolve) => {
    finish = resolve;
  });
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
          kill: () => finish({ status: "error", summary: "Stopped", view: [] }),
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
    textStep("Completion processed"),
  ]);
  f.provider.stream = continuation.stream.bind(continuation);
  await f.service.deliver(child, "Start background work", "send");
  await f.service.whenIdle(child);
  expect(
    (await f.store.listActiveItems(child)).some(
      (item) => item.type === "tool_result" && item.callId === "list" && item.status === "ok",
    ),
  ).toBe(true);
  await f.dismiss.execute({ to: child }, f.context(f.root.id));
  finish({
    status: "ok",
    summary: "Activity completed",
    view: [{ type: "text", text: "Background result" }],
  });
  await vi.waitFor(async () =>
    expect(
      (await f.store.listActiveItems(child)).some(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          textOf(item.content) === "Completion processed",
      ),
    ).toBe(true),
  );
  await f.service.whenIdle(child);
  expect(
    (await f.store.listActiveItems(child)).some(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.source?.kind === "plugin" &&
        textOf(item.content).includes("Activity completed"),
    ),
  ).toBe(true);
});

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
  expect((await peek.execute({ id: "review" }, f.context(f.root.id))).status).toBe("ok");
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
