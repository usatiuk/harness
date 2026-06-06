import { describe, expect, test } from "vitest";
import type { HarnessStore } from "@harness/core";
import type { ProfileConfig } from "@harness/protocol";

const recordingProfile: ProfileConfig = {
  model: { provider: "fake", adapter: "recording", modelId: "recording" },
  promptFragments: ["system rules"]
};

export interface StoreContractHarness {
  store: HarnessStore;
  close?: () => void;
}

export function runHarnessStoreContract(name: string, open: () => Promise<StoreContractHarness> | StoreContractHarness): void {
  describe(`${name} HarnessStore contract`, () => {
    test("stores profiles and default profile selection", async () => {
      const harness = await open();
      try {
        const store = harness.store;
        const profile = await store.createProfile({ name: "recording", config: recordingProfile });

        await store.setDefaultProfileName(profile.name);

        expect(await store.getDefaultProfileName()).toBe("recording");
        expect(await store.getProfileByName("recording")).toMatchObject({ config: recordingProfile });
        expect(await store.listProfiles()).toEqual([profile]);
      } finally {
        harness.close?.();
      }
    }, 5000);

    test("appends conversation items with monotonic per-conversation sequences", async () => {
      const harness = await open();
      try {
        const store = harness.store;
        const conversation = await store.createConversation({ config: recordingProfile });

        const first = await store.appendConversationItem({
          conversationId: conversation.id,
          class: "transcript",
          kind: "user_message",
          role: "user",
          visibility: "model",
          content: [{ type: "text", text: "one" }]
        });
        const second = await store.appendConversationItem({
          conversationId: conversation.id,
          class: "audit",
          kind: "audit_note",
          visibility: "audit",
          content: [{ type: "text", text: "two" }]
        });

        expect([first.sequence, second.sequence]).toEqual([1, 2]);
        expect(await store.getLatestItemSequence(conversation.id)).toBe(2);
        expect(await store.listConversationItems(conversation.id, { after: 1 })).toEqual([second]);
      } finally {
        harness.close?.();
      }
    }, 5000);

    test("records runs, context builds, projections, and provider state", async () => {
      const harness = await open();
      try {
        const store = harness.store;
        const conversation = await store.createConversation({ config: recordingProfile });
        const user = await store.appendConversationItem({
          conversationId: conversation.id,
          class: "transcript",
          kind: "user_message",
          role: "user",
          visibility: "model",
          content: [{ type: "text", text: "input" }]
        });
        const run = await store.createAgentRun({
          conversationId: conversation.id,
          startedThroughItemSequence: user.sequence,
          modelConfig: recordingProfile.model
        });
        const projection = await store.createContextProjection({
          conversationId: conversation.id,
          itemId: user.id,
          coversThroughItemSequence: user.sequence,
          policyId: "test",
          content: [{ type: "text", text: "summary" }],
          tokenEstimate: 2,
          diagnostics: { itemCount: 1 }
        });
        const contextBuild = await store.createContextBuild({
          conversationId: conversation.id,
          runId: run.id,
          modelConfig: recordingProfile.model,
          projectionId: projection.id,
          selectedItemIds: [user.id],
          selectedItemSequences: [user.sequence],
          diagnostics: { providerStateSelected: false }
        });
        const providerState = await store.createProviderState({
          conversationId: conversation.id,
          provider: "fake",
          adapter: "recording",
          modelId: "recording",
          payloadVersion: 1,
          payload: { replay: true },
          producedThroughItemSequence: user.sequence,
          referencedItemSequences: [user.sequence]
        });
        const completed = await store.updateAgentRun({
          id: run.id,
          status: "completed",
          completedThroughItemSequence: user.sequence,
          providerStateId: providerState.id
        });

        expect(await store.listAgentRuns(conversation.id)).toEqual([completed]);
        expect(await store.getActiveAgentRun(conversation.id)).toBeUndefined();
        expect(await store.listContextProjections(conversation.id)).toEqual([projection]);
        expect(await store.listContextBuilds(conversation.id)).toEqual([contextBuild]);
        expect(await store.getLatestProviderState(conversation.id)).toEqual(providerState);
      } finally {
        harness.close?.();
      }
    }, 5000);

    test("enforces one active run per conversation", async () => {
      const harness = await open();
      try {
        const store = harness.store;
        const conversation = await store.createConversation({ config: recordingProfile });
        await store.createAgentRun({
          conversationId: conversation.id,
          startedThroughItemSequence: 0,
          modelConfig: recordingProfile.model
        });

        await expect(store.createAgentRun({
          conversationId: conversation.id,
          startedThroughItemSequence: 0,
          modelConfig: recordingProfile.model
        })).rejects.toThrow();
      } finally {
        harness.close?.();
      }
    }, 5000);
  });
}
