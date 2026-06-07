import type { ContentBlock, EffectiveProfile, JsonValue, ConversationRecord, ToolCall, ToolResult } from "@harness/protocol";
import type { ApprovalPolicyContextSnapshot, PluginToolApprovalDecision } from "./approval-policy.ts";
import type { HarnessTool } from "./tools.ts";
import type { ActivityDriver } from "./activities.ts";

export interface HarnessPlugin {
  id: string;
  contextFragments?(input: { conversation: ConversationRecord; effectiveProfile: EffectiveProfile; pluginConfig?: JsonValue }): Promise<ContentBlock[]>;
  beforeToolCall?(input: { conversation: ConversationRecord; call: ToolCall; effectiveProfile: EffectiveProfile; pluginConfig?: JsonValue }): Promise<ToolCall | { blocked: true; reason: string }>;
  afterToolResult?(input: { conversation: ConversationRecord; call: ToolCall; result: ToolResult; effectiveProfile: EffectiveProfile; pluginConfig?: JsonValue }): Promise<void>;
  onConversationCreated?(input: { conversation: ConversationRecord; effectiveProfile: EffectiveProfile; pluginConfig?: JsonValue }): Promise<void>;
  evaluateToolApproval?(input: {
    conversation: ConversationRecord;
    call: ToolCall;
    tool: HarnessTool;
    effectiveProfile: EffectiveProfile;
    pluginConfig?: JsonValue;
    context: ApprovalPolicyContextSnapshot;
  }): Promise<PluginToolApprovalDecision>;
  activityDrivers?: Record<string, ActivityDriver>;
}

export class PluginHost {
  public constructor(private readonly plugins: HarnessPlugin[]) {}

  public list(): HarnessPlugin[] {
    return this.plugins;
  }

  public getActivityDriver(ownerPluginId: string, kind: string): ActivityDriver | undefined {
    const plugin = this.plugins.find((item) => item.id === ownerPluginId);
    return plugin?.activityDrivers?.[kind];
  }

  public async collectContextFragments(input: { conversation: ConversationRecord; effectiveProfile: EffectiveProfile }): Promise<ContentBlock[]> {
    const fragments: ContentBlock[] = [];
    for (const { plugin, pluginConfig } of this.activePlugins(input.effectiveProfile)) {
      const pluginFragments = await plugin.contextFragments?.({ ...input, ...(pluginConfig === undefined ? {} : { pluginConfig }) });
      if (pluginFragments) {
        fragments.push(...pluginFragments);
      }
    }
    return fragments;
  }

  public async beforeToolCall(input: { conversation: ConversationRecord; call: ToolCall; effectiveProfile: EffectiveProfile }): Promise<ToolCall | { blocked: true; reason: string }> {
    let next: ToolCall = input.call;
    for (const { plugin, pluginConfig } of this.activePlugins(input.effectiveProfile)) {
      const result = await plugin.beforeToolCall?.({ ...input, call: next, ...(pluginConfig === undefined ? {} : { pluginConfig }) });
      if (result && "blocked" in result) {
        return result;
      }
      if (result) {
        next = result;
      }
    }
    return next;
  }

  public async afterToolResult(input: { conversation: ConversationRecord; call: ToolCall; result: ToolResult; effectiveProfile: EffectiveProfile }): Promise<void> {
    for (const { plugin, pluginConfig } of this.activePlugins(input.effectiveProfile)) {
      await plugin.afterToolResult?.({ ...input, ...(pluginConfig === undefined ? {} : { pluginConfig }) });
    }
  }

  public async onConversationCreated(input: { conversation: ConversationRecord; effectiveProfile: EffectiveProfile }): Promise<void> {
    for (const { plugin, pluginConfig } of this.activePlugins(input.effectiveProfile)) {
      await plugin.onConversationCreated?.({ ...input, ...(pluginConfig === undefined ? {} : { pluginConfig }) });
    }
  }

  public async evaluateToolApproval(input: {
    conversation: ConversationRecord;
    call: ToolCall;
    tool: HarnessTool;
    effectiveProfile: EffectiveProfile;
    context: ApprovalPolicyContextSnapshot;
  }): Promise<PluginToolApprovalDecision> {
    for (const { plugin, pluginConfig } of this.activePlugins(input.effectiveProfile)) {
      const decision = await plugin.evaluateToolApproval?.({ ...input, ...(pluginConfig === undefined ? {} : { pluginConfig }) });
      if (decision && decision.decision !== "abstain") {
        return decision;
      }
    }
    return { decision: "abstain" };
  }

  private activePlugins(effectiveProfile: EffectiveProfile): Array<{ plugin: HarnessPlugin; pluginConfig?: JsonValue }> {
    return this.plugins.flatMap((plugin) => {
      const profileConfig = effectiveProfile.config.plugins[plugin.id];
      if (!profileConfig?.enabled) {
        return [];
      }
      return [{ plugin, ...(profileConfig.config === undefined ? {} : { pluginConfig: profileConfig.config }) }];
    });
  }
}
