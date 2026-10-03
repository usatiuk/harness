import type { ConversationId } from "@harness/protocol";
import type { ActivityResult } from "./activity.ts";

/** Lifecycle events the manager emits onto the conversation's stream. */
export type ActivityEvent =
  | {
      type: "activity.started";
      conversationId: ConversationId;
      id: string;
      kind: string;
      title: string;
    }
  | {
      type: "activity.exited";
      conversationId: ConversationId;
      id: string;
      status: ActivityResult["status"];
      summary: string;
    };

/** Narrows the open event stream to this plugin's events; mirror of `isKernelEvent`. */
export function isActivityEvent(event: { type: string }): event is ActivityEvent {
  return event.type === "activity.started" || event.type === "activity.exited";
}
