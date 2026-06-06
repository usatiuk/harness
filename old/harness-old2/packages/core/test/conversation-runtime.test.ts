import { describe, expect, test } from "vitest";
import { BlockingModelAdapter, RecordingModelAdapter, createTestHarness } from "@harness/testkit";
import type { ModelStepResult, ProfileConfig } from "@harness/protocol";

const recordingProfile: ProfileConfig = {
  model: { provider: "fake", adapter: "recording", modelId: "recording" },
  promptFragments: []
};

function textBlocks(text: string) {
  return [{ type: "text" as const, text }];
}

describe("conversation item runtime", () => {
  test("persists a simple user and assistant transcript as ordered conversation items", async () => {
    const { service, model } = createTestHarness();
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    await service.send(conversation.id, textBlocks("hello"));

    const items = await service.listItems(conversation.id);
    expect(items.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(items.map((item) => item.kind)).toEqual(["audit_note", "user_message", "run_event", "assistant_message"]);
    expect(items.filter((item) => item.visibility === "model").map((item) => item.kind)).toEqual(["user_message", "assistant_message"]);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]?.messages.map((message) => message.role)).toEqual(["user"]);
    expect(model.inputs[0]?.messages[0]?.content).toEqual(textBlocks("hello"));
    expect(await service.listAgentRuns(conversation.id)).toMatchObject([{ status: "completed" }]);
  }, 5000);

  test("manual notes are UI-only and do not trigger a model run", async () => {
    const { service, model } = createTestHarness();
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    const item = await service.manual(conversation.id, textBlocks("operator note"));

    expect(item.visibility).toBe("ui");
    expect(model.inputs).toHaveLength(0);
    expect(await service.listAgentRuns(conversation.id)).toEqual([]);
  }, 5000);

  test("unknown profile names fail instead of falling back to fake defaults", async () => {
    const { service } = createTestHarness();

    await expect(service.createConversation({ profileName: "typo" })).rejects.toThrow("Profile typo not found");
  }, 5000);

  test("model failure appends a visible error but no partial assistant message", async () => {
    const model = new RecordingModelAdapter({ fail: new Error("provider down") });
    const { service } = createTestHarness(model);
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    await expect(service.send(conversation.id, textBlocks("fail please"))).rejects.toThrow("provider down");

    const items = await service.listItems(conversation.id);
    expect(items.some((item) => item.kind === "assistant_message")).toBe(false);
    expect(items.filter((item) => item.kind === "model_error")).toHaveLength(1);
    expect(await service.getConversation(conversation.id)).toMatchObject({ status: "failed" });
    expect(await service.listAgentRuns(conversation.id)).toMatchObject([{ status: "failed" }]);
  }, 5000);

  test("compaction keeps old items inspectable while future prompts use projection plus newer transcript only", async () => {
    const { service, model } = createTestHarness();
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    await service.send(conversation.id, textBlocks("first"));
    await service.send(conversation.id, textBlocks("second"));
    const beforeCompaction = await service.listItems(conversation.id);
    const projection = await service.runCompaction(conversation.id);
    await service.send(conversation.id, textBlocks("third"));

    expect(projection.kind).toBe("context_projection");
    expect(await service.listItems(conversation.id)).toHaveLength(beforeCompaction.length + 4);
    const latestInput = model.inputs.at(-1);
    expect(latestInput?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(latestInput?.messages[0]?.content[0]).toMatchObject({ type: "text" });
    expect(latestInput?.messages[1]?.content).toEqual(textBlocks("third"));
    expect(latestInput?.messages.some((message) => JSON.stringify(message.content).includes("first"))).toBe(true);
    expect(latestInput?.messages.filter((message) => message.role !== "system").some((message) => JSON.stringify(message.content).includes("first"))).toBe(false);
  }, 5000);

  test("provider state is reused only while its referenced transcript remains selected", async () => {
    const model = new RecordingModelAdapter();
    model.enqueue((input) => providerStateResult(selectedSequences(input), "one"));
    model.enqueue((input) => providerStateResult(selectedSequences(input), "two"));
    model.enqueue({ content: [{ type: "text", text: "three" }] });
    const { service } = createTestHarness(model);
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    await service.send(conversation.id, textBlocks("one"));
    await service.send(conversation.id, textBlocks("two"));
    expect(model.inputs[1]?.providerState).toBeDefined();

    await service.runCompaction(conversation.id);
    await service.send(conversation.id, textBlocks("three"));

    expect(model.inputs[2]?.providerState).toBeUndefined();
  }, 5000);

  test("queued input during an active run is promoted after the active assistant message", async () => {
    const model = new BlockingModelAdapter();
    const { service } = createTestHarness(model);
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    const firstSend = service.send(conversation.id, textBlocks("first"));
    await model.waitForStart();
    const queued = await service.queue(conversation.id, textBlocks("second"));

    expect(queued).toMatchObject({ class: "control", visibility: "ui", kind: "user_message" });

    model.unblock({ content: [{ type: "text", text: "first answer" }] });
    await model.waitForCalls(2);
    expect(model.inputs[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(model.inputs[1]?.messages.map((message) => message.content[0])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "first answer" },
      { type: "text", text: "second" }
    ]);
    model.unblock({ content: [{ type: "text", text: "second answer" }] });
    await firstSend;

    const items = await service.listItems(conversation.id);
    expect(items.filter((item) => item.class === "transcript").map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message"
    ]);
  }, 5000);

  test("interrupt cancels the active run and starts a fresh run without persisting interrupted output", async () => {
    const model = new BlockingModelAdapter();
    const { service } = createTestHarness(model);
    const conversation = await service.createConversation({ profileConfig: recordingProfile });

    const firstSend = service.send(conversation.id, textBlocks("slow"));
    await model.waitForStart();
    const interrupt = service.interrupt(conversation.id, textBlocks("new input"));

    model.unblock({ content: [{ type: "text", text: "cancelled output" }] });
    await model.waitForCalls(2);
    expect(model.inputs[1]?.messages.map((message) => message.content[0])).toEqual([
      { type: "text", text: "new input" }
    ]);
    model.unblock({ content: [{ type: "text", text: "fresh output" }] });

    await firstSend;
    await interrupt;

    const items = await service.listItems(conversation.id);
    expect(items.filter((item) => item.kind === "assistant_message").map((item) => item.content[0])).toEqual([
      { type: "text", text: "fresh output" }
    ]);
    expect(await service.listAgentRuns(conversation.id)).toMatchObject([
      { status: "cancelled" },
      { status: "completed" }
    ]);
  }, 5000);
});

function selectedSequences(input: { messages: Array<{ metadata: Record<string, unknown> }> }): number[] {
  return input.messages
    .map((message) => message.metadata.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number");
}

function providerStateResult(referencedItemSequences: number[], text: string): ModelStepResult {
  return {
    content: [{ type: "text", text }],
    providerState: {
      payloadVersion: 1,
      payload: { state: text },
      referencedItemSequences
    }
  };
}
