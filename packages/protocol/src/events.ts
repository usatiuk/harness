import type { ContentBlock } from "./content.ts";
import type { ConversationId, TurnId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ToolStatus } from "./tools.ts";
import type { TurnStatus } from "./conversation.ts";

/** The fixed set the kernel itself emits. Structured data, never pre-rendered text. */
export type KernelEvent =
  | { type: "turn.status"; turnId: TurnId; status: TurnStatus; error?: string }
  | { type: "message"; item: Item }
  | { type: "reasoning"; item: Item }
  | { type: "compaction"; item: Item }
  | { type: "text_delta"; turnId: TurnId; text: string }
  | { type: "reasoning_delta"; turnId: TurnId; text: string }
  | { type: "tool_call.started"; callId: string; name: string; args: unknown }
  | {
      type: "tool_call.completed";
      callId: string;
      status: ToolStatus;
      forModel: ContentBlock[];
    }
  | {
      type: "request.created";
      requestId: string;
      conversationId: ConversationId;
      request: unknown;
    }
  | { type: "request.resolved"; requestId: string; conversationId: ConversationId };

/**
 * A plugin-defined event. `string & {}` keeps the union open without collapsing
 * the kernel literals, so `switch (e.type)` still narrows the `KernelEvent` arms.
 */
export interface PluginEvent {
  type: string & {};
  [key: string]: unknown;
}

/** What flows on the event stream: kernel events plus anything plugins emit. */
export type HarnessEvent = KernelEvent | PluginEvent;

const KERNEL_EVENT_TYPES = new Set<KernelEvent["type"]>([
  "turn.status",
  "message",
  "reasoning",
  "compaction",
  "text_delta",
  "reasoning_delta",
  "tool_call.started",
  "tool_call.completed",
  "request.created",
  "request.resolved",
]);

/**
 * Narrows the open stream to the kernel union. An open union can't be `switch`-
 * narrowed (one arm's discriminant is `string`), so consumers guard with this,
 * then `switch` over the resulting `KernelEvent`; everything else is a plugin event.
 */
export function isKernelEvent(event: HarnessEvent): event is KernelEvent {
  return (KERNEL_EVENT_TYPES as Set<string>).has(event.type);
}
