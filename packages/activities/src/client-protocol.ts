import { z } from "zod";
import { defineNotification, defineRequest, wireContentBlockSchema } from "@harness/protocol";

export const ACTIVITIES_CLIENT_CONTRACT_VERSION = 1;

export const activityStateSchema = z.strictObject({
  conversationId: z.string(),
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.enum(["ok", "error"]).nullable(),
  summary: z.string().nullable(),
});

export const activitiesSnapshotSchema = z.strictObject({
  activities: z.array(activityStateSchema),
});

export const activitiesEventNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.activities.event",
  params: z.strictObject({
    rootConversationId: z.string(),
    event: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("started"),
        conversationId: z.string(),
        id: z.string(),
        kind: z.string(),
        title: z.string(),
      }),
      z.strictObject({
        type: z.literal("exited"),
        conversationId: z.string(),
        id: z.string(),
        status: z.enum(["ok", "error"]),
        summary: z.string(),
      }),
    ]),
  }),
});

export const activityPeekRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.activities.peek",
  params: z.strictObject({ conversationId: z.string(), activityId: z.string() }),
  result: z.strictObject({ content: z.array(wireContentBlockSchema) }),
});

export const activityKillRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.activities.kill",
  params: z.strictObject({ conversationId: z.string(), activityId: z.string() }),
  result: z.strictObject({ status: z.enum(["requested", "settled", "unknown"]) }),
});

export type ActivityState = z.infer<typeof activityStateSchema>;
export type ActivitiesSnapshot = z.infer<typeof activitiesSnapshotSchema>;
