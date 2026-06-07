import type { HarnessKernel } from "@harness/core";
import type { ActivityRecord, ContentBlock, MessageRecord, ProfileConfig, ConversationRecord } from "@harness/protocol";
import { SUBAGENTS_PLUGIN_ID } from "./plugin.ts";

export class SubagentDelegator {
  public constructor(private readonly kernel: HarnessKernel) {}

  public async delegate(input: {
    parentConversationId: string;
    prompt: string;
    title?: string;
  }): Promise<{ childConversation: ConversationRecord; activity: ActivityRecord }> {
    const parent = await this.kernel.getConversation(input.parentConversationId);
    if (!parent) {
      throw new Error(`Parent conversation ${input.parentConversationId} not found`);
    }
    const inheritedOverrides = parent.effectiveProfile.conversationOverrides as Partial<ProfileConfig> | undefined;
    const childConversation = await this.kernel.createConversation({
      parentConversationId: parent.id,
      ...(parent.profileId ? { profileId: parent.profileId } : {}),
      ...(inheritedOverrides ? { profileOverrides: inheritedOverrides } : {}),
      ...(parent.executionContextId ? { executionContextId: parent.executionContextId } : {}),
      title: input.title ?? `child of ${parent.id}`
    });
    const content: ContentBlock[] = [{ type: "text", text: input.prompt }];
    const activity = await this.kernel.createActivity({
      conversationId: parent.id,
      ownerPluginId: SUBAGENTS_PLUGIN_ID,
      kind: "plugin.subagents.run",
      label: input.title ?? `subagent: ${childConversation.id}`,
      status: "running",
      cancellable: true,
      activityState: { childConversationId: childConversation.id },
      onCompletion: { delivery: "asap" }
    });

    await this.kernel.sendConversationInput({
      conversationId: childConversation.id,
      content,
      delivery: "asap",
      role: "user"
    });

    await this.kernel.appendEvent({
      conversationId: parent.id,
      source: { type: "activity", id: activity.id },
      type: "child_conversation.created",
      payload: { childConversationId: childConversation.id }
    });

    return { childConversation, activity };
  }

  public async send(input: { activityId: string; message: ContentBlock[] }): Promise<{ activity: ActivityRecord; queuedInputId: string }> {
    const { activity, childConversationId } = await this.requireSubagentActivity(input.activityId);
    const queued = await this.kernel.sendConversationInput({
      conversationId: childConversationId,
      content: input.message,
      delivery: "asap",
      role: "user"
    });
    return { activity, queuedInputId: queued.id };
  }

  public async peek(activityId: string): Promise<SubagentSnapshot> {
    const { activity, childConversationId } = await this.requireSubagentActivity(activityId);
    const childConversation = await this.kernel.store.getConversation(childConversationId);
    if (!childConversation) {
      throw new Error(`Child conversation ${childConversationId} not found`);
    }
    const messages = await this.kernel.store.listMessages(childConversationId, { limit: 20 });
    return { activity, childConversation, messages };
  }

  public async wait(activityId: string): Promise<SubagentSnapshot> {
    return this.peek(activityId);
  }

  public async cancel(activityId: string): Promise<ActivityRecord> {
    await this.kernel.cancelActivity(activityId);
    const activity = await this.kernel.store.getActivity(activityId);
    if (!activity) {
      throw new Error(`Subagent activity ${activityId} not found`);
    }
    return activity;
  }

  private async requireSubagentActivity(activityId: string): Promise<{ activity: ActivityRecord; childConversationId: string }> {
    const activity = await this.kernel.store.getActivity(activityId);
    if (!activity) {
      throw new Error(`Subagent activity ${activityId} not found`);
    }
    if (activity.ownerPluginId !== SUBAGENTS_PLUGIN_ID || activity.kind !== "plugin.subagents.run") {
      throw new Error(`Activity ${activityId} is not a subagent activity`);
    }
    const state = activity.activityState as { childConversationId?: string } | undefined;
    if (!state?.childConversationId) {
      throw new Error(`Subagent activity ${activityId} is missing child conversation state`);
    }
    return { activity, childConversationId: state.childConversationId };
  }
}

export interface SubagentSnapshot {
  activity: ActivityRecord;
  childConversation: ConversationRecord;
  messages: MessageRecord[];
}
