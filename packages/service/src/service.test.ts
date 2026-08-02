import { describe, expect, it } from "vitest";
import { conversationOf } from "@harness/protocol";
import type { HarnessEvent, Store } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { EchoTool, FakeProvider, textStep, toolStep } from "@harness/testkit";
import { HarnessService } from "./service.ts";

const serviceOn = (store: Store, steps: ConstructorParameters<typeof FakeProvider>[0]) =>
  new HarnessService({
    store,
    home: "/nonexistent-harness-home", // hermetic: no real global settings
    plugins: [
      { id: "fake", providers: () => [new FakeProvider(steps)], tools: () => [new EchoTool()] },
    ],
  });

describe("HarnessService", () => {
  it("drives a turn and streams the event sequence", async () => {
    const store = new InMemoryStore();
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home", // hermetic: no real global settings
      plugins: [
        {
          id: "fake",
          providers: () => [new FakeProvider([toolStep("c1", "echo", { x: 1 }), textStep("done")])],
          tools: () => [new EchoTool()],
        },
      ],
    });

    const events: HarnessEvent[] = [];
    service.subscribe((e) => events.push(e));

    const conv = await service.createConversation({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    await service.send(conv.id, "hello");
    await service.whenIdle(conv.id);

    expect(events.map((e) => e.type).filter((t) => t !== "inbox")).toEqual([
      "turn.status",
      "message",
      "tool_call.started",
      "tool_call.completed",
      "usage",
      "text_delta",
      "message",
      "usage",
      "turn.status",
    ]);
  });

  it("scopes a subscription to a single conversation", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("a"), textStep("b")]);
    const overrides = { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } };
    const a = await service.createConversation({ overrides });
    const b = await service.createConversation({ overrides });

    const scoped: HarnessEvent[] = [];
    service.subscribe(a.id, (e) => scoped.push(e));

    await service.send(a.id, "hi");
    await service.whenIdle(a.id);
    await service.send(b.id, "yo");
    await service.whenIdle(b.id);

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => conversationOf(e) === a.id)).toBe(true);
  });

  it("disposes runtime services in reverse registration order and rebuilds them on reload", async () => {
    const store = new InMemoryStore();
    const disposed: string[] = [];
    let builds = 0;
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      plugins: [
        { id: "fake", providers: () => [new FakeProvider([])] },
        {
          id: "execution-owner",
          services: () => [
            {
              key: "execution",
              for: () => ({ id: ++builds }),
              dispose: () => {
                disposed.push("execution");
              },
            },
          ],
        },
        {
          id: "activity-owner",
          services: () => [
            {
              key: "activities",
              for: () => ({ id: ++builds }),
              dispose: () => {
                disposed.push("activities");
              },
            },
          ],
        },
      ],
    });
    const conv = await service.createConversation({
      overrides: { instructions: "", model: { provider: "fake", model: "fake-1" } },
    });

    await service.prepare(conv.id);
    const firstExecution = service.service(conv.id, "execution");
    service.service(conv.id, "activities");
    await expect(service.deactivateSession(conv.id)).resolves.toEqual({
      status: "deactivated",
    });
    expect(disposed).toEqual(["activities", "execution"]);

    await service.prepare(conv.id);
    expect(service.service(conv.id, "execution")).not.toBe(firstExecution);
  });

  it("reports cleanup failures after disposing the remaining services", async () => {
    const store = new InMemoryStore();
    const disposed: string[] = [];
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      plugins: [
        { id: "fake", providers: () => [new FakeProvider([])] },
        {
          id: "one",
          services: () => [
            {
              key: "execution",
              for: () => ({}),
              dispose: () => {
                disposed.push("execution");
              },
            },
          ],
        },
        {
          id: "two",
          services: () => [
            {
              key: "activities",
              for: () => ({}),
              dispose: () => {
                throw new Error("stuck");
              },
            },
          ],
        },
      ],
    });
    const conv = await service.createConversation({
      overrides: { instructions: "", model: { provider: "fake", model: "fake-1" } },
    });
    await service.prepare(conv.id);
    service.service(conv.id, "activities");

    await expect(service.deactivateSession(conv.id)).rejects.toThrow(
      "conversation cleanup failed: activities: Error: stuck",
    );
    expect(disposed).toEqual(["execution"]);
    await expect(service.prepare(conv.id)).resolves.toBeUndefined();
  });

  it("resumes a conversation from the store in a fresh service and continues it", async () => {
    const store = new InMemoryStore();

    // First "process": create a conversation and drive a turn to completion.
    const first = serviceOn(store, [toolStep("c1", "echo", { x: 1 }), textStep("done")]);
    const conv = await first.createConversation({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    await first.send(conv.id, "hello");
    await first.whenIdle(conv.id);

    // A fresh service attaches to the same store and rehydrates the active chain.
    const second = serviceOn(store, [textStep("welcome back")]);
    expect((await second.getConversation(conv.id))?.id).toBe(conv.id);
    const resumed = await second.getItems(conv.id);
    expect(resumed.map((i) => i.type)).toEqual(["message", "tool_call", "tool_result", "message"]);

    // ...and a deliver continues the conversation it did not create.
    await second.send(conv.id, "still there?");
    await second.whenIdle(conv.id);
    const after = await second.getItems(conv.id);
    expect(after.length).toBe(resumed.length + 2); // new user message + assistant reply
    const lastAssistant = after
      .filter((i) => i.type === "message" && i.role === "assistant")
      .at(-1);
    expect(lastAssistant?.type === "message" && lastAssistant.content).toEqual([
      { type: "text", text: "welcome back" },
    ]);
  });

  it("listConversations skips a conversation whose settings fail to resolve", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("x")]);
    const good = await service.createConversation({
      overrides: { model: { provider: "fake", model: "fake-1" } },
    });
    // Inserted via the store directly — createConversation would (correctly) reject an unknown plugin.
    await store.createConversation({ workspaceRoot: null, overrides: { plugins: { ghost: {} } } });

    expect((await service.listConversations()).map((c) => c.id)).toEqual([good.id]);
  });

  it("createConversation rolls back the record when its settings fail to resolve", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("x")]);
    await expect(
      service.createConversation({
        overrides: { model: { provider: "fake", model: "fake-1" }, plugins: { ghost: {} } },
      }),
    ).rejects.toThrow(/unknown plugin 'ghost'/);
    expect(await store.listConversations()).toEqual([]);
  });
});
