import type { HarnessEvent, ModelConfig } from "@harness/protocol";
export interface AutoApprovalEvent {
  type: "auto-approval.reviewing";
  conversationId?: string;
  callId: string;
  name: string;
  model: ModelConfig;
}

export const isAutoApprovalEvent = (
  event: HarnessEvent,
): event is HarnessEvent & AutoApprovalEvent => event.type === "auto-approval.reviewing";
