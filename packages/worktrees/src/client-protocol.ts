import { z } from "zod";
import {
  conversationCreateRequest,
  defineRequest,
  type WorkspaceSelection,
} from "@harness/protocol";

export const WORKTREES_CLIENT_CONTRACT_VERSION = 4;

export const changeModeSchema = z.enum(["uncommitted", "unstaged", "staged", "branch", "unpushed"]);
export type ChangeMode = z.infer<typeof changeModeSchema>;
const changeFileSchema = z.strictObject({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["A", "M", "D", "R", "C", "T", "U", "?"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangeFile = z.infer<typeof changeFileSchema>;
const comparisonParams = {
  conversationId: z.string(),
  mode: changeModeSchema,
};
export const changesListRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.changes.list",
  params: z.strictObject({
    ...comparisonParams,
    after: z.string().nullable(),
    limit: z.number().int().min(1).max(200),
  }),
  result: z.strictObject({
    repository: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    upstream: z.string().nullable(),
    unavailable: z.string().nullable(),
    files: z.array(changeFileSchema),
    nextCursor: z.string().nullable(),
  }),
});
export type ChangesPage = z.infer<typeof changesListRequest.result>;
export const changesDiffRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.worktrees.changes.diff",
  params: z.strictObject({
    ...comparisonParams,
    path: z.string().min(1),
    previousPath: z.string().nullable(),
  }),
  result: z.strictObject({
    patch: z.string(),
    unavailable: z.string().nullable(),
  }),
});
export type FileDiff = z.infer<typeof changesDiffRequest.result>;

const tree = z.strictObject({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  locked: z.boolean(),
});
export const workspaceSelectionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("original") }),
    z.strictObject({ kind: z.literal("new"), branch: z.string().min(1).optional() }),
    z.strictObject({ kind: z.literal("existing"), path: z.string().min(1) }),
  ])
  .transform((selection): WorkspaceSelection =>
    selection.kind === "new"
      ? { kind: "new", ...(selection.branch === undefined ? {} : { branch: selection.branch }) }
      : selection,
  );
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
