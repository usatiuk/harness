import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { HarnessKernel } from "@harness/core";
import { HarnessService } from "@harness/service";
import { openSqliteHarnessStore } from "@harness/store-sqlite";
import { RecordingModelProvider } from "@harness/testkit";
import type { ProfileConfig } from "@harness/protocol";
import { runHarnessStoreContract } from "../../testkit/test/store-contract.ts";

const recordingProfile: ProfileConfig = {
    model: { provider: "fake", modelId: "recording" },
    promptFragments: [],
};

runHarnessStoreContract("SqliteHarnessStore", async () => {
    const store = openSqliteHarnessStore({ path: await tempDbPath() });
    return { store, close: () => store.close() };
});

describe("SQLite conversation store persistence", () => {
    test("persists conversation items, runs, context builds, and provider payloads across reopen", async () => {
        const dbPath = await tempDbPath();
        const model = new RecordingModelProvider();
        model.enqueue({
            assistant: {
                content: [{ type: "text", text: "persisted" }],
                providerPayload: {
                    type: "fake.payload",
                    version: 1,
                    payload: { encoded: true },
                },
            },
        });

        const firstStore = openSqliteHarnessStore({ path: dbPath });
        const service = new HarnessService(
            new HarnessKernel({ store: firstStore, models: [model] }),
        );
        const conversation = await service.createConversation({
            profileConfig: recordingProfile,
        });
        await service.send(conversation.id, [
            { type: "text", text: "persist me" },
        ]);
        const assistant = (await service.listItems(conversation.id)).find(
            (item) => item.type === "message" && item.role === "assistant",
        );
        firstStore.close();

        const reopened = openSqliteHarnessStore({ path: dbPath });
        try {
            expect(
                await reopened.listConversationItems(conversation.id),
            ).toHaveLength(2);
            expect(await reopened.listAgentRuns(conversation.id)).toMatchObject(
                [{ status: "completed" }],
            );
            expect(
                await reopened.listContextBuilds(conversation.id),
            ).toHaveLength(1);
            expect(
                await reopened.listProviderPayloadsForItems({
                    conversationId: conversation.id,
                    itemIds: assistant ? [assistant.id] : [],
                    provider: "fake",
                    modelId: "recording",
                }),
            ).toMatchObject([
                {
                    provider: "fake",
                    modelId: "recording",
                    type: "fake.payload",
                },
            ]);
        } finally {
            reopened.close();
        }
    }, 5000);

    test("rejects items for missing conversations", async () => {
        const store = openSqliteHarnessStore({ path: await tempDbPath() });
        try {
            await expect(
                store.appendConversationItem({
                    conversationId: "conv_missing",
                    type: "message",
                    role: "user",
                    status: "complete",
                    content: [{ type: "text", text: "orphan" }],
                }),
            ).rejects.toThrow();
        } finally {
            store.close();
        }
    }, 5000);
});

async function tempDbPath(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-sqlite-"));
    return path.join(dir, "test.sqlite");
}
