import type { ContentBlock, EffectiveProfile, JsonValue, ConversationRecord, ToolCall } from "@harness/protocol";
import type { PluginHost } from "./plugins.ts";
import type { HarnessTool } from "./tools.ts";

export type ToolApprovalDecision =
  | { decision: "approved"; reason?: string }
  | { decision: "denied"; reason: string }
  | { decision: "needs_interaction"; prompt: ContentBlock[] };

export type PluginToolApprovalDecision = ToolApprovalDecision | { decision: "abstain"; reason?: string };

export interface ApprovalPolicyContextSnapshot {
  conversationId: string;
  turnId: string;
  toolName: string;
  profileId?: string;
}

export class ApprovalPolicyEngine {
  public constructor(private readonly plugins: PluginHost) {}

  public async evaluateToolCall(input: {
    conversation: ConversationRecord;
    turnId: string;
    call: ToolCall;
    tool: HarnessTool;
    effectiveProfile: EffectiveProfile;
  }): Promise<ToolApprovalDecision> {
    const policy = input.effectiveProfile.config.approvalPolicy;
    if (policy.denyTools.includes(input.tool.name)) {
      return { decision: "denied", reason: `Tool ${input.tool.name} is denied by profile approval policy` };
    }
    if (policy.allowTools.includes(input.tool.name)) {
      return { decision: "approved", reason: `Tool ${input.tool.name} is allowed by profile approval policy` };
    }

    const snapshot: ApprovalPolicyContextSnapshot = {
      conversationId: input.conversation.id,
      turnId: input.turnId,
      toolName: input.tool.name,
      ...(input.effectiveProfile.profileId ? { profileId: input.effectiveProfile.profileId } : {})
    };
    const pluginDecision = await this.plugins.evaluateToolApproval({
      conversation: input.conversation,
      call: input.call,
      tool: input.tool,
      effectiveProfile: input.effectiveProfile,
      context: snapshot
    });
    if (pluginDecision.decision !== "abstain") {
      return pluginDecision;
    }

    if (policy.mode === "never") {
      return { decision: "approved", reason: "Profile approval policy is never" };
    }
    if (policy.mode === "always") {
      return {
        decision: "needs_interaction",
        prompt: approvalPrompt(input.tool, input.call, snapshot)
      };
    }
    return { decision: "approved", reason: "Profile approval policy is on-request and no hook requested approval" };
  }
}

function approvalPrompt(tool: HarnessTool, call: ToolCall, snapshot: ApprovalPolicyContextSnapshot): ContentBlock[] {
  const data = {
    tool: tool.name,
    input: call.input,
    description: tool.description
  } as unknown as JsonValue;
  return [
    {
      type: "text",
      text: `Approve tool ${tool.name}?`
    },
    {
      type: "data",
      label: "tool_call",
      data
    }
  ];
}
