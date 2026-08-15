import type { DeliveryIntent } from "./delivery.ts";
import type { ConversationId, TurnId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ModelUsageSummary } from "./usage.ts";
import type { ConversationConfig } from "./conversation.ts";
import type { TurnStatus } from "./conversation.ts";

/**
 * Carried by every event bound to a single conversation, so a client (or the scoped
 * subscription) can attribute it without inspecting the variant. Global events carry none.
 */
export interface ConversationEvent {
  conversationId: ConversationId;
}

/**
 * The fixed set the kernel itself emits. Structured data, never pre-rendered text.
 * `conversationId` is factored out via `ConversationEvent`, so every arm carries it.
 */
export type KernelEvent = ConversationEvent &
  (
    | { type: "turn.status"; turnId: TurnId; status: TurnStatus; error?: string }
    | { type: "item.appended"; item: Item }
    | { type: "head.changed"; head: Item["parent"] }
    | { type: "text_delta"; turnId: TurnId; text: string }
    | { type: "reasoning_delta"; turnId: TurnId; text: string }
    | { type: "request.created"; requestId: string; request: unknown }
    | { type: "request.resolved"; requestId: string }
    | { type: "config.changed"; config: ConversationConfig }
    // `inbox`: snapshot of accepted-but-not-yet-injected input (queue/steer), re-emitted on
    // every inbox mutation; `pending: []` means it drained.
    | { type: "inbox"; pending: { intent: DeliveryIntent; text: string }[] }
    | { type: "usage.changed"; summary: ModelUsageSummary }
  );

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
  "item.appended",
  "head.changed",
  "text_delta",
  "reasoning_delta",
  "request.created",
  "request.resolved",
  "config.changed",
  "inbox",
  "usage.changed",
]);

/**
 * Narrows the open stream to the kernel union. An open union can't be `switch`-
 * narrowed (one arm's discriminant is `string`), so consumers guard with this,
 * then `switch` over the resulting `KernelEvent`; everything else is a plugin event.
 */
export function isKernelEvent(event: HarnessEvent): event is KernelEvent {
  return (KERNEL_EVENT_TYPES as Set<string>).has(event.type);
}

/**
 * The conversation an event belongs to, or `undefined` for a global event that carries none.
 * The seam the scoped subscription filters on; plugin events opt in by carrying `conversationId`.
 */
export function conversationOf(event: HarnessEvent): ConversationId | undefined {
  const id = (event as { conversationId?: unknown }).conversationId;
  return typeof id === "string" ? (id as ConversationId) : undefined;
}
