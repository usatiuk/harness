import { describe, expect, it } from "vitest";
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

    expect(events.map((e) => e.type)).toEqual([
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
});
