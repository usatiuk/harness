import { describe, expect, test } from "vitest";
import {
    BlockingModelProvider,
    RecordingModelProvider,
    createTestHarness,
} from "@harness/testkit";
import type {
    ContentBlock,
    ModelFinalResponse,
    ModelRequest,
    ProfileConfig,
} from "@harness/protocol";

const recordingProfile: ProfileConfig = {
    model: { provider: "fake", modelId: "recording" },
    promptFragments: [],
};

function textBlocks(text: string): ContentBlock[] {
    return [{ type: "text", text }];
}

describe("conversation runtime", () => {
    test("persists a simple user and assistant exchange as ordered conversation items", async () => {
        const { service, model } = createTestHarness();
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        await service.send(conversation.id, textBlocks("hello"));

        const items = await service.listItems(conversation.id);
        expect(items.map((item) => item.sequence)).toEqual([1, 2]);
        expect(items.map((item) => item.type)).toEqual(["message", "message"]);
        expect(
            items.map((item) =>
                item.type === "message" ? item.role : item.type,
            ),
        ).toEqual(["user", "assistant"]);
        expect(model.inputs).toHaveLength(1);
        expect(inputRoles(model.inputs[0])).toEqual(["user"]);
        expect(model.inputs[0]?.items[0]?.content).toEqual(
            textBlocks("hello"),
        );
        expect(await service.listAgentRuns(conversation.id)).toMatchObject([
            { status: "completed" },
        ]);
    }, 5000);

    test("unknown profile names fail instead of falling back to fake defaults", async () => {
        const { service } = createTestHarness();

        await expect(
            service.createConversation({ profileName: "typo" }),
        ).rejects.toThrow("Profile typo not found");
    }, 5000);

    test("model failure appends an ordered model_error item but no partial assistant message", async () => {
        const model = new RecordingModelProvider({
            fail: new Error("provider down"),
        });
        const { service } = createTestHarness(model);
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        await expect(
            service.send(conversation.id, textBlocks("fail please")),
        ).rejects.toThrow("provider down");

        const items = await service.listItems(conversation.id);
        expect(
            items.some(
                (item) => item.type === "message" && item.role === "assistant",
            ),
        ).toBe(false);
        expect(items.filter((item) => item.type === "model_error")).toHaveLength(
            1,
        );
        expect(await service.getConversation(conversation.id)).toMatchObject({
            status: "failed",
        });
        expect(await service.listAgentRuns(conversation.id)).toMatchObject([
            { status: "failed" },
        ]);
    }, 5000);

    test("compaction keeps old items inspectable while future prompts use compaction plus newer messages only", async () => {
        const { service, model } = createTestHarness();
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        await service.send(conversation.id, textBlocks("first"));
        await service.send(conversation.id, textBlocks("second"));
        const beforeCompaction = await service.listItems(conversation.id);
        const compaction = await service.runCompaction(conversation.id);
        await service.send(conversation.id, textBlocks("third"));

        expect(compaction).toMatchObject({ type: "compaction" });
        expect(await service.listItems(conversation.id)).toHaveLength(
            beforeCompaction.length + 3,
        );
        const latestInput = model.inputs.at(-1);
        expect(inputRoles(latestInput)).toEqual(["system", "user"]);
        expect(latestInput?.items[0]?.content[0]).toMatchObject({
            type: "text",
        });
        expect(latestInput?.items[1]?.content).toEqual(textBlocks("third"));
        expect(
            JSON.stringify(latestInput?.items[0]?.content).includes("first"),
        ).toBe(true);
        expect(
            latestInput?.items
                .filter((item) => item.role !== "system")
                .some((item) => JSON.stringify(item.content).includes("first")),
        ).toBe(false);
    }, 5000);

    test("provider payloads attach only to selected matching assistant items", async () => {
        const model = new RecordingModelProvider();
        model.enqueue(() => providerPayloadResult("one"));
        model.enqueue(() => providerPayloadResult("two"));
        model.enqueue({
            assistant: { content: [{ type: "text", text: "three" }] },
        });
        const { service } = createTestHarness(model);
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        await service.send(conversation.id, textBlocks("one"));
        await service.send(conversation.id, textBlocks("two"));
        const assistantWithPayload = model.inputs[1]?.items.find(
            (item) => item.role === "assistant",
        );
        expect(assistantWithPayload?.providerPayload).toMatchObject({
            type: "fake.payload",
            payload: { text: "one" },
        });

        await service.runCompaction(conversation.id);
        await service.send(conversation.id, textBlocks("three"));

        expect(
            model.inputs[2]?.items.some(
                (item) => item.providerPayload !== undefined,
            ),
        ).toBe(false);
    }, 5000);

    test("queue during an active run is ephemeral and becomes a user message after the active assistant message", async () => {
        const model = new BlockingModelProvider();
        const { service } = createTestHarness(model);
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        const firstSend = service.send(conversation.id, textBlocks("first"));
        await model.waitForStart();
        const queued = await service.queue(
            conversation.id,
            textBlocks("second"),
        );

        expect(queued).toMatchObject({
            conversationId: conversation.id,
            requestedDelivery: "queue",
            afterRunId: expect.any(String) as string,
        });
        expect("sequence" in queued).toBe(false);
        expect(await service.listItems(conversation.id)).toHaveLength(1);

        model.unblock({
            assistant: { content: [{ type: "text", text: "first answer" }] },
        });
        await model.waitForCalls(2);
        expect(inputRoles(model.inputs[1])).toEqual([
            "user",
            "assistant",
            "user",
        ]);
        expect(model.inputs[1]?.items.map((item) => item.content[0])).toEqual([
            { type: "text", text: "first" },
            { type: "text", text: "first answer" },
            { type: "text", text: "second" },
        ]);
        model.unblock({
            assistant: { content: [{ type: "text", text: "second answer" }] },
        });
        await firstSend;

        const messages = (await service.listItems(conversation.id)).filter(
            (item) => item.type === "message",
        );
        expect(messages.map((item) => item.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
        ]);
    }, 5000);

    test("interrupt cancels the active run and starts a fresh run without persisting interrupted output", async () => {
        const model = new BlockingModelProvider();
        const { service } = createTestHarness(model);
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });

        const firstSend = service.send(conversation.id, textBlocks("slow"));
        await model.waitForStart();
        const interrupt = service.interrupt(
            conversation.id,
            textBlocks("new input"),
        );

        model.unblock({
            assistant: {
                content: [{ type: "text", text: "cancelled output" }],
            },
        });
        await model.waitForCalls(2);
        expect(model.inputs[1]?.items.map((item) => item.content[0])).toEqual([
            { type: "text", text: "new input" },
        ]);
        model.unblock({
            assistant: { content: [{ type: "text", text: "fresh output" }] },
        });

        await firstSend;
        await interrupt;

        const assistantMessages = (await service.listItems(conversation.id))
            .filter(
                (item) => item.type === "message" && item.role === "assistant",
            )
            .map((item) => item.content[0]);
        expect(assistantMessages).toEqual([
            { type: "text", text: "fresh output" },
        ]);
        expect(await service.listAgentRuns(conversation.id)).toMatchObject([
            { status: "cancelled" },
            { status: "completed" },
        ]);
    }, 5000);
});

function inputRoles(
    input: ModelRequest | undefined,
): Array<string | undefined> {
    return input?.items.map((contextItem) => contextItem.role) ?? [];
}

function providerPayloadResult(text: string): ModelFinalResponse {
    return {
        assistant: {
            content: [{ type: "text", text }],
            providerPayload: {
                type: "fake.payload",
                version: 1,
                payload: { text },
            },
        },
    };
}
