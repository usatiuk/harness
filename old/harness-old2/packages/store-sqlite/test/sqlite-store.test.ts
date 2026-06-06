import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { HarnessKernel } from "@harness/core";
import { HarnessService } from "@harness/service";
import { openSqliteHarnessStore } from "@harness/store-sqlite";
import { RecordingModelAdapter } from "@harness/testkit";
import type { ProfileConfig } from "@harness/protocol";
import { runHarnessStoreContract } from "../../testkit/test/store-contract.ts";

const recordingProfile: ProfileConfig = {
  model: { provider: "fake", adapter: "recording", modelId: "recording" },
  promptFragments: []
};

runHarnessStoreContract("SqliteHarnessStore", async () => {
  const store = openSqliteHarnessStore({ path: await tempDbPath() });
  return { store, close: () => store.close() };
});

describe("SQLite conversation store persistence", () => {
  test("persists conversation items, runs, context builds, and provider state across reopen", async () => {
    const dbPath = await tempDbPath();
    const model = new RecordingModelAdapter();
    model.enqueue((input) => ({
      content: [{ type: "text", text: "persisted" }],
      providerState: {
        payloadVersion: 1,
        payload: { replay: true },
        referencedItemSequences: input.messages
          .map((message) => message.metadata.sequence)
          .filter((sequence): sequence is number => typeof sequence === "number")
      }
    }));

    const firstStore = openSqliteHarnessStore({ path: dbPath });
    const service = new HarnessService(new HarnessKernel({ store: firstStore, models: [model] }));
    const conversation = await service.createConversation({ profileConfig: recordingProfile });
    await service.send(conversation.id, [{ type: "text", text: "persist me" }]);
    firstStore.close();

    const reopened = openSqliteHarnessStore({ path: dbPath });
    try {
      expect(await reopened.listConversationItems(conversation.id)).toHaveLength(4);
      expect(await reopened.listAgentRuns(conversation.id)).toMatchObject([{ status: "completed" }]);
      expect(await reopened.listContextBuilds(conversation.id)).toHaveLength(1);
      expect(await reopened.getLatestProviderState(conversation.id)).toMatchObject({
        provider: "fake",
        adapter: "recording",
        modelId: "recording"
      });
    } finally {
      reopened.close();
    }
  }, 5000);

  test("rejects items for missing conversations", async () => {
    const store = openSqliteHarnessStore({ path: await tempDbPath() });
    try {
      await expect(store.appendConversationItem({
        conversationId: "conv_missing",
        class: "transcript",
        kind: "user_message",
        role: "user",
        visibility: "model",
        content: [{ type: "text", text: "orphan" }]
      })).rejects.toThrow();
    } finally {
      store.close();
    }
  }, 5000);
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-sqlite-"));
  return path.join(dir, "test.sqlite");
}
