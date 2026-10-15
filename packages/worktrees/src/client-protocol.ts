import { z } from "zod";
import { conversationCreateRequest, defineRequest } from "@harness/protocol";

export const WORKTREES_CLIENT_CONTRACT_VERSION = 1;

const tree = z.strictObject({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  locked: z.boolean(),
});
export const workspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("original") }),
  z.strictObject({ kind: z.literal("new") }),
  z.strictObject({ kind: z.literal("existing"), path: z.string().min(1) }),
]);
export const worktreeOptionsRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.options",
  params: z.strictObject({ conversationId: z.string() }),
  result: z
    .strictObject({ original: z.string(), current: z.string(), worktrees: z.array(tree) })
    .nullable(),
});
export const worktreeSwitchRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.switch",
  params: z.strictObject({ conversationId: z.string(), selection: workspaceSelectionSchema }),
  result: z.strictObject({ path: z.string(), deferred: z.boolean() }),
});
export const worktreeManagedRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.list",
  params: z.strictObject({
    limit: z.number().int().positive().max(100),
    before: z.string().nullable(),
  }),
  result: z.array(
    z.strictObject({ path: z.string(), repository: z.string(), createdAt: z.number() }),
  ),
});
export const worktreeRemoveRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.remove",
  params: z.strictObject({ path: z.string(), force: z.boolean() }),
  result: z.null(),
});

export const worktreeRepositoryRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.repository",
  params: z.strictObject({ path: z.string() }),
  result: z.string().nullable(),
});
export const worktreeCreateConversationRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.createConversation",
  params: conversationCreateRequest.params,
  result: conversationCreateRequest.result,
});
