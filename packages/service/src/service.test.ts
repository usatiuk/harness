import { describe, expect, it } from "vitest";
import type { Event } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { EchoTool, FakeProvider, textStep, toolStep } from "@harness/testkit";
import { HarnessService } from "./service.ts";

describe("HarnessService", () => {
  it("drives a turn and streams the event sequence", async () => {
    const store = new InMemoryStore();
    const service = new HarnessService({
      store,
      plugins: [
        {
          id: "fake",
          providers: () => [new FakeProvider([toolStep("c1", "echo", { x: 1 }), textStep("done")])],
          tools: () => [new EchoTool()],
        },
      ],
    });

    const events: Event[] = [];
    service.subscribe((e) => events.push(e));

    const conv = await service.createConversation({
      instructions: "be helpful",
      model: { provider: "fake", model: "fake-1" },
    });
    await service.send(conv.id, "hello");

    expect(events.map((e) => e.type)).toEqual([
      "turn.status",
      "message",
      "tool_call.started",
      "tool_call.completed",
      "text_delta",
      "message",
      "turn.status",
    ]);
  });
});
