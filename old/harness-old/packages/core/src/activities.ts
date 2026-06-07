import type { ActivityRecord, ContentBlock, JsonValue } from "@harness/protocol";

export function isActiveActivity(activity: ActivityRecord): boolean {
  return activity.status === "queued" || activity.status === "running" || activity.status === "waiting";
}

export interface ActivityDriver {
  status(activity: ActivityRecord): Promise<JsonValue>;
  cancel(activity: ActivityRecord): Promise<void>;
  resume?(activity: ActivityRecord, input?: JsonValue): Promise<JsonValue | void>;
  summarizeCompletion?(activity: ActivityRecord): Promise<ContentBlock[] | undefined>;
}
