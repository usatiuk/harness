import { z } from "zod";
export { subagentLimitsSchema } from "./config.ts";
import { defineRequest } from "@harness/protocol";

export const SUBAGENTS_CLIENT_CONTRACT_VERSION = 3;

export const subagentsTopLevelRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.subagents.topLevel",
  params: z.strictObject({ conversationIds: z.array(z.string()).max(100) }),
  result: z.strictObject({ conversationIds: z.array(z.string()) }),
});

export const subagentIdentitySchema = z.strictObject({
  name: z.string(),
  slug: z.string(),
  agent: z.string(),
  ancestors: z.array(z.strictObject({ id: z.string(), name: z.string() })),
});
export const subagentRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  agent: z.string(),
  status: z.enum(["running", "completed", "failed", "aborted"]),
  hasChildren: z.boolean(),
  running: z.number().int().nonnegative(),
});
const cursor = z.strictObject({ createdAt: z.number(), id: z.string() });
export const subagentsInspectRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.subagents.inspect",
  params: z.strictObject({ conversationId: z.string() }),
  result: subagentIdentitySchema.nullable(),
});
export const subagentsListRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.subagents.list",
  params: z.strictObject({
    conversationId: z.string(),
    limit: z.number().int().min(1).max(100),
    cursor: cursor.nullable(),
  }),
  result: z.strictObject({
    children: z.array(subagentRowSchema),
    nextCursor: cursor.nullable(),
    running: z.number().int().nonnegative(),
  }),
});
export type SubagentIdentity = z.infer<typeof subagentIdentitySchema>;
export type SubagentRow = z.infer<typeof subagentRowSchema>;
export type SubagentPage = z.infer<typeof subagentsListRequest.result>;
