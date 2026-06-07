import { describe, expect, test } from "vitest";
import type { HarnessStore } from "@harness/core";
import type { ProfileConfig } from "@harness/protocol";

const recordingProfile: ProfileConfig = {
    model: { provider: "fake", modelId: "recording" },
    promptFragments: ["system rules"],
};

export interface StoreContractHarness {
    store: HarnessStore;
    close?: () => void;
}

export function runHarnessStoreContract(
    name: string,
    open: () => Promise<StoreContractHarness> | StoreContractHarness,
): void {
    describe(`${name} HarnessStore contract`, () => {
        test("stores profiles and default profile selection", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const profile = await store.createProfile({
                    name: "recording",
                    config: recordingProfile,
                });

                await store.setDefaultProfileName(profile.name);

                expect(await store.getDefaultProfileName()).toBe("recording");
                expect(await store.getProfileByName("recording")).toMatchObject(
                    {
                        config: recordingProfile,
                    },
                );
                expect(await store.listProfiles()).toEqual([profile]);
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("appends typed conversation items with monotonic sequences", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });

                const user = await store.appendConversationItem({
                    conversationId: conversation.id,
                    type: "message",
                    role: "user",
                    status: "complete",
                    content: [{ type: "text", text: "one" }],
                });
                const modelChange = await store.appendConversationItem({
                    conversationId: conversation.id,
                    type: "model_change",
                    provider: "fake",
                    modelId: "recording",
                });
                const compaction = await store.appendConversationItem({
                    conversationId: conversation.id,
                    type: "compaction",
                    summary: [{ type: "text", text: "summary" }],
                    coversThroughItemSequence: user.sequence,
                    policyId: "test",
                    tokenEstimate: 2,
                });

                expect([user.sequence, modelChange.sequence, compaction.sequence]).toEqual([
                    1,
                    2,
                    3,
                ]);
                expect(await store.getLatestItemSequence(conversation.id)).toBe(
                    3,
                );
                expect(
                    await store.listConversationItems(conversation.id, {
                        after: 1,
                    }),
                ).toEqual([modelChange, compaction]);
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("records runs, context builds, and provider payloads", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });
                const user = await store.appendConversationItem({
                    conversationId: conversation.id,
                    type: "message",
                    role: "user",
                    status: "complete",
                    content: [{ type: "text", text: "input" }],
                });
                const run = await store.createAgentRun({
                    conversationId: conversation.id,
                    startedThroughItemSequence: user.sequence,
                    modelConfig: recordingProfile.model,
                });
                const contextBuild = await store.createContextBuild({
                    conversationId: conversation.id,
                    runId: run.id,
                    modelConfig: recordingProfile.model,
                    selectedItemIds: [user.id],
                    selectedItemSequences: [user.sequence],
                    diagnostics: { providerPayloadCount: 0 },
                });
                const providerPayload = await store.createProviderPayload({
                    conversationId: conversation.id,
                    itemId: user.id,
                    itemSequence: user.sequence,
                    provider: "fake",
                    modelId: "recording",
                    type: "fake.payload",
                    version: 1,
                    payload: { encoded: true },
                });
                const completed = await store.updateAgentRun({
                    id: run.id,
                    status: "completed",
                    completedThroughItemSequence: user.sequence,
                });

                expect(await store.listAgentRuns(conversation.id)).toEqual([
                    completed,
                ]);
                expect(
                    await store.getActiveAgentRun(conversation.id),
                ).toBeUndefined();
                expect(await store.listContextBuilds(conversation.id)).toEqual([
                    contextBuild,
                ]);
                expect(
                    await store.listProviderPayloadsForItems({
                        conversationId: conversation.id,
                        itemIds: [user.id],
                        provider: "fake",
                        modelId: "recording",
                    }),
                ).toEqual([providerPayload]);
                await expect(
                    store.createProviderPayload({
                        conversationId: conversation.id,
                        itemId: user.id,
                        itemSequence: user.sequence,
                        provider: "fake",
                        modelId: "recording",
                        type: "fake.payload",
                        version: 1,
                        payload: { encoded: "duplicate" },
                    }),
                ).rejects.toThrow();
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("listConversationItems without a limit returns the full log", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });
                for (let index = 0; index < 1005; index += 1) {
                    await store.appendConversationItem({
                        conversationId: conversation.id,
                        type: "message",
                        role: "user",
                        status: "complete",
                        content: [{ type: "text", text: `message ${index}` }],
                    });
                }

                expect(
                    await store.listConversationItems(conversation.id),
                ).toHaveLength(1005);
                expect(
                    await store.listConversationItems(conversation.id, {
                        limit: 2,
                    }),
                ).toHaveLength(2);
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("commits assistant response transactionally", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });
                const user = await store.appendConversationItem({
                    conversationId: conversation.id,
                    type: "message",
                    role: "user",
                    status: "complete",
                    content: [{ type: "text", text: "input" }],
                });
                const run = await store.createAgentRun({
                    conversationId: conversation.id,
                    startedThroughItemSequence: user.sequence,
                    modelConfig: recordingProfile.model,
                });
                const beforeFailedCommit = await store.listConversationItems(
                    conversation.id,
                );

                await expect(
                    store.commitAssistantResponse({
                        conversationId: conversation.id,
                        runId: run.id,
                        modelConfig: recordingProfile.model,
                        content: [{ type: "text", text: "bad output" }],
                        providerPayload: {
                            type: "fake.payload",
                            version: 0,
                            payload: { invalid: true },
                        },
                    }),
                ).rejects.toThrow();

                expect(
                    await store.listConversationItems(conversation.id),
                ).toEqual(beforeFailedCommit);
                expect(await store.getAgentRun(run.id)).toEqual(run);

                const committed = await store.commitAssistantResponse({
                    conversationId: conversation.id,
                    runId: run.id,
                    modelConfig: recordingProfile.model,
                    content: [{ type: "text", text: "good output" }],
                    providerResponse: {
                        provider: "fake",
                        modelId: "recording",
                        responseId: "resp_fake",
                    },
                    accounting: {
                        usage: {
                            inputTokens: 1,
                            outputTokens: 2,
                        },
                    },
                    providerPayload: {
                        type: "fake.payload",
                        version: 1,
                        payload: { text: "good output" },
                    },
                });

                expect(committed.assistantItem).toMatchObject({
                    type: "message",
                    role: "assistant",
                });
                expect(committed.providerPayload).toMatchObject({
                    provider: "fake",
                    modelId: "recording",
                    type: "fake.payload",
                    payload: { text: "good output" },
                });
                expect(committed.run).toMatchObject({
                    status: "completed",
                    outputItemId: committed.assistantItem.id,
                    providerResponse: {
                        responseId: "resp_fake",
                    },
                    accounting: {
                        usage: {
                            inputTokens: 1,
                            outputTokens: 2,
                        },
                    },
                });
            } finally {
                harness.close?.();
            }
        }, 5000);
    });
}
