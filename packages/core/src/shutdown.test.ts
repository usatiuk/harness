import { expect, it } from "vitest";
import { textOf, type DeliveryInput, type Plugin } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import {
  FakeProvider,
  GateTool,
  newConversationInput,
  testConfigResolver,
  textStep,
  toolStep,
  unusedCodeEvaluator,
} from "@harness/testkit";
import { Engine } from "./engine.ts";
import { PluginHost } from "./plugin-host.ts";

function latch() {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = resolve));
  return { open, reached };
}

const config = newConversationInput({ model: { provider: "fake", model: "fake-1" } });
const input = (text: string): DeliveryInput => ({
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function setup(plugin: Plugin) {
  const store = new InMemoryStore();
  const engine = new Engine(
    store,
    new PluginHost([plugin]),
    testConfigResolver(),
    unusedCodeEvaluator,
  );
  return { store, engine };
}

it.each(["queue", "steer"] as const)(
  "retains all accepted %s input if shutdown aborts an onInput hook midway through delivery",
  async (intent) => {
    const tool = new GateTool();
    const observing = latch();
    const { store, engine } = setup({
      id: "consumer",
      providers: () => [new FakeProvider([toolStep("hold", tool.name, {}), textStep("Done")])],
      tools: () => [tool],
      services: () => [
        {
          key: "input-observer",
          for: () => ({}),
          async onInput(_service, ctx) {
            if (textOf(ctx.input.content) !== "First") return;
            observing.open();
            await new Promise<void>((_resolve, reject) =>
              ctx.signal.addEventListener(
                "abort",
                () => reject(new Error("input observer stopped")),
                { once: true },
              ),
            );
          },
        },
      ],
    });
    const { id } = await store.createConversation(config);
    await engine.deliver(id, input("Start"));
    await tool.started;
    await engine.deliver(id, input("First"), intent);
    await engine.deliver(id, input("Second"), intent);
    tool.release();
    await observing.reached;
    await engine.deliver(id, input("Later"), "queue");
    await engine.deactivate(id, { force: true });
    expect(
      (await store.listActiveItems(id)).flatMap((item) =>
        item.type === "message" && item.role === "user" ? [textOf(item.content)] : [],
      ),
    ).toEqual(["Start", "First", "Second", "Later"]);
    expect((await store.getLatestTurn(id))?.status).toBe("aborted");
  },
);

it("rejects a dismissal that arrives from a joined producer after shutdown fenced its group", async () => {
  const { engine, store } = setup({ id: "fake", providers: () => [new FakeProvider([])] });
  const root = await store.createConversation(config);
  const child = await store.createConversation({ ...config, parentId: root.id });
  await engine.prepare(root.id);
  engine.registerChild(root.id, child.id);
  await engine.prepare(child.id);
  await engine.stopSessions([root.id], async () => {
    const dismissal = engine.closeThread(child.id).then(
      () => "closed",
      () => "rejected",
    );
    // Sealing the durable branch before checking the stop fence is already too late.
    expect((await store.getConversation(child.id))?.closed).not.toBe(true);
    expect(await dismissal).toBe("rejected");
  });
  expect((await store.getConversation(child.id))?.closed).not.toBe(true);
  expect(engine.conversationTreeState(root.id)).toEqual([]);
});

it("joins a dismissal already in progress and reports its cleanup failure", async () => {
  const disposing = latch();
  const finish = latch();
  const { engine, store } = setup({
    id: "resource",
    services: () => [
      {
        key: "owned-resource",
        for: () => ({}),
        async dispose() {
          disposing.open();
          await finish.reached;
          throw new Error("child cleanup failed");
        },
      },
    ],
  });
  const root = await store.createConversation(config);
  const child = await store.createConversation({ ...config, parentId: root.id });
  await engine.prepare(root.id);
  engine.registerChild(root.id, child.id);
  await engine.prepare(child.id);
  engine.serviceFor(child.id, "owned-resource");
  const dismissal = expect(engine.closeThread(child.id)).rejects.toThrow(/child cleanup failed/);
  await disposing.reached;
  const joined = expect(engine.stopSessions([root.id])).rejects.toThrow(/child cleanup failed/);
  finish.open();
  await Promise.all([dismissal, joined]);
  expect((await store.getConversation(child.id))?.closed).toBe(true);
  expect(engine.conversationTreeState(root.id)).toEqual([]);
});
