import { describe, expect, test } from "vitest";
import type { HarnessStore } from "@harness/core";
import type { ProfileConfig } from "@harness/protocol";

const recordingProfile: ProfileConfig = {
    model: { provider: "fake", adapter: "recording", modelId: "recording" },
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

        test("appends conversation items with monotonic per-conversation sequences", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });

                const first = await store.appendConversationItem({
                    conversationId: conversation.id,
                    class: "transcript",
                    kind: "user_message",
                    role: "user",
                    visibility: "model",
                    content: [{ type: "text", text: "one" }],
                });
                const second = await store.appendConversationItem({
                    conversationId: conversation.id,
                    class: "audit",
                    kind: "audit_note",
                    visibility: "audit",
                    content: [{ type: "text", text: "two" }],
                });

                expect([first.sequence, second.sequence]).toEqual([1, 2]);
                expect(await store.getLatestItemSequence(conversation.id)).toBe(
                    2,
                );
                expect(
                    await store.listConversationItems(conversation.id, {
                        after: 1,
                    }),
                ).toEqual([second]);
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("records runs, context builds, projections, and provider encodings", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });
                const user = await store.appendConversationItem({
                    conversationId: conversation.id,
                    class: "transcript",
                    kind: "user_message",
                    role: "user",
                    visibility: "model",
                    content: [{ type: "text", text: "input" }],
                });
                const run = await store.createAgentRun({
                    conversationId: conversation.id,
                    startedThroughItemSequence: user.sequence,
                    modelConfig: recordingProfile.model,
                });
                const projection = await store.createContextProjection({
                    conversationId: conversation.id,
                    itemId: user.id,
                    coversThroughItemSequence: user.sequence,
                    policyId: "test",
                    content: [{ type: "text", text: "summary" }],
                    tokenEstimate: 2,
                    diagnostics: { itemCount: 1 },
                });
                const contextBuild = await store.createContextBuild({
                    conversationId: conversation.id,
                    runId: run.id,
                    modelConfig: recordingProfile.model,
                    projectionId: projection.id,
                    selectedItemIds: [user.id],
                    selectedItemSequences: [user.sequence],
                    diagnostics: { providerEncodingCount: 0 },
                });
                const providerEncoding = await store.createProviderEncoding({
                    conversationId: conversation.id,
                    itemId: user.id,
                    itemSequence: user.sequence,
                    provider: "fake",
                    adapter: "recording",
                    modelId: "recording",
                    format: "fake.encoding",
                    formatVersion: 1,
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
                expect(
                    await store.listContextProjections(conversation.id),
                ).toEqual([projection]);
                expect(await store.listContextBuilds(conversation.id)).toEqual([
                    contextBuild,
                ]);
                expect(
                    await store.listProviderEncodingsForItems({
                        conversationId: conversation.id,
                        itemIds: [user.id],
                        provider: "fake",
                        adapter: "recording",
                        modelId: "recording",
                    }),
                ).toEqual([providerEncoding]);
                await expect(
                    store.createProviderEncoding({
                        conversationId: conversation.id,
                        itemId: user.id,
                        itemSequence: user.sequence,
                        provider: "fake",
                        adapter: "recording",
                        modelId: "recording",
                        format: "fake.encoding",
                        formatVersion: 1,
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
                        class: "transcript",
                        kind: "user_message",
                        role: "user",
                        visibility: "model",
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
                    class: "transcript",
                    kind: "user_message",
                    role: "user",
                    visibility: "model",
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
                        providerEvents: [],
                        providerEncoding: {
                            format: "fake.encoding",
                            formatVersion: 0,
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
                    providerEvents: [
                        {
                            provider: "fake",
                            modelId: "recording",
                            sequence: 0,
                            kind: "provider.test",
                            normalized: { ok: true },
                        },
                    ],
                    providerEncoding: {
                        format: "fake.encoding",
                        formatVersion: 1,
                        payload: { encoded: true },
                    },
                });

                expect(committed.assistantItem.kind).toBe("assistant_message");
                expect(committed.providerEventItems).toHaveLength(1);
                expect(committed.providerEncoding).toMatchObject({
                    itemId: committed.assistantItem.id,
                });
                expect(committed.run).toMatchObject({ status: "completed" });
            } finally {
                harness.close?.();
            }
        }, 5000);

        test("enforces one active run per conversation", async () => {
            const harness = await open();
            try {
                const store = harness.store;
                const conversation = await store.createConversation({
                    config: recordingProfile,
                });
                await store.createAgentRun({
                    conversationId: conversation.id,
                    startedThroughItemSequence: 0,
                    modelConfig: recordingProfile.model,
                });

                await expect(
                    store.createAgentRun({
                        conversationId: conversation.id,
                        startedThroughItemSequence: 0,
                        modelConfig: recordingProfile.model,
                    }),
                ).rejects.toThrow();
            } finally {
                harness.close?.();
            }
        }, 5000);
    });
}
