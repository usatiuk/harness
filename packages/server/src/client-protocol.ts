import { z } from "zod";
import { sandboxBackendSchema } from "@harness/sandbox/client";
import { subagentLimitsSchema } from "@harness/subagents/client";
import {
  defineNotification,
  defineRequest,
  compactionThresholdSchema,
  conversationListRequest,
  jsonValueSchema,
} from "@harness/protocol";

const model = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  preset: z.string().nullable(),
});
import {
  toolPermissionSchema as effect,
  humanApprovalTimeoutSchema,
} from "@harness/approval/client";
/** Model retry policy bounds; shared by the server boundary and the settings UI. */
export const modelRetriesSettingsSchema = z.strictObject({
  attempts: z.number().int().min(0).max(10),
  backoffMs: z.number().int().min(50).max(60_000),
});
const settings = z.strictObject({
  model: model.nullable(),
  conversationTitleModel: model.nullable(),
  approval: z.strictObject({
    inWorkspace: effect,
    outOfWorkspace: effect,
    humanApprovalTimeoutSeconds: humanApprovalTimeoutSchema,
  }),
  autoApproval: z.strictObject({
    enabled: z.boolean(),
    model: model.nullable(),
    timeoutSeconds: z.number().positive().max(2147483).default(30),
  }),
  sandbox: sandboxBackendSchema,
  toolMode: z.preprocess(
    (val) => (val === "direct" ? "hybrid" : val),
    z.enum(["hybrid", "code-only"]),
  ),
  showToolNames: z.boolean(),
  subagents: subagentLimitsSchema,
  compactionThresholdTokens: compactionThresholdSchema.nullable(),
  worktreeDirectory: z.string().trim().min(1).nullable(),
  modelRetries: modelRetriesSettingsSchema,
});
const providerSettingSchema = z.strictObject({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  value: z.boolean(),
});
export type ProviderSetting = z.infer<typeof providerSettingSchema>;
export const providerStatusSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  kind: z.enum(["api-key", "oauth", "none"]),
  canStore: z.boolean(),
  authenticated: z.boolean(),
  detail: z.string().nullable(),
  credentialSource: z.enum(["env", "stored"]).nullable(),
  registered: z.boolean(),
  catalog: z.enum([
    "ready",
    "degraded",
    "failed",
    "missing-credentials",
    "credentials-unavailable",
  ]),
  modelCount: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()),
  settings: z.array(providerSettingSchema),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export const appProvidersRequest = defineRequest({
  direction: "client-to-server",
  method: "app.providers.list",
  params: z.strictObject({}),
  result: z.array(providerStatusSchema),
});

export const appSettingsRequest = defineRequest({
  direction: "client-to-server",
  method: "app.settings.get",
  params: z.strictObject({}),
  result: z.strictObject({
    home: z.string(),
    cwd: z.string(),
    platform: z.enum(["win32", "darwin", "linux"]),
    settings,
    providers: z.array(providerStatusSchema),
  }),
});
export const appSettingsUpdateRequest = defineRequest({
  direction: "client-to-server",
  method: "app.settings.update",
  params: settings.partial().transform((patch) => ({
    ...(patch.model === undefined ? {} : { model: patch.model }),
    ...(patch.conversationTitleModel === undefined
      ? {}
      : { conversationTitleModel: patch.conversationTitleModel }),
    ...(patch.approval === undefined ? {} : { approval: patch.approval }),
    ...(patch.autoApproval === undefined ? {} : { autoApproval: patch.autoApproval }),
    ...(patch.subagents === undefined ? {} : { subagents: patch.subagents }),
    ...(patch.sandbox === undefined ? {} : { sandbox: patch.sandbox }),
    ...(patch.toolMode === undefined ? {} : { toolMode: patch.toolMode }),
    ...(patch.showToolNames === undefined ? {} : { showToolNames: patch.showToolNames }),
    ...(patch.worktreeDirectory === undefined
      ? {}
      : { worktreeDirectory: patch.worktreeDirectory }),
    ...(patch.compactionThresholdTokens === undefined
      ? {}
      : { compactionThresholdTokens: patch.compactionThresholdTokens }),
    ...(patch.modelRetries === undefined ? {} : { modelRetries: patch.modelRetries }),
  })),
  result: z.null(),
});
export const appProviderCreateRequest = defineRequest({
  direction: "client-to-server",
  method: "app.providers.create",
  params: z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(200),
    type: z.string().min(1),
    config: z.record(z.string(), jsonValueSchema),
  }),
  result: z.strictObject({ restartRequired: z.literal(true) }),
});
export const appProviderConfigUpdateRequest = defineRequest({
  direction: "client-to-server",
  method: "app.providers.config.update",
  params: z.strictObject({
    provider: z.string().min(1),
    patch: z.record(z.string().min(1), z.boolean()),
  }),
  result: z.strictObject({ restartRequired: z.literal(true) }),
});
export const appAuthLoginRequest = defineRequest({
  direction: "client-to-server",
  method: "app.auth.login",
  params: z.strictObject({
    provider: z.string(),
    key: z.string().nullable(),
    flow: z.enum(["browser", "device"]),
  }),
  result: z.strictObject({ restartRequired: z.literal(true) }),
});
export const appAuthLogoutRequest = defineRequest({
  direction: "client-to-server",
  method: "app.auth.logout",
  params: z.strictObject({ provider: z.string() }),
  result: z.strictObject({ restartRequired: z.literal(true) }),
});
export const appAuthUrlNotification = defineNotification({
  direction: "server-to-client",
  method: "app.auth.url",
  params: z.strictObject({
    url: z.string().url(),
    userCode: z.string().min(1).max(128).nullable(),
  }),
});
export type AppSettings = z.infer<typeof appSettingsRequest.result>;

const projectSummary = z.strictObject({ workspaceRoot: z.string(), lastUsedAt: z.number().int() });
export const appConversationProjectsRequest = defineRequest({
  direction: "client-to-server",
  method: "app.conversations.projects",
  params: z.strictObject({
    limit: z.number().int().positive().max(100),
    cursor: projectSummary.nullable(),
  }),
  result: z.strictObject({
    projects: z.array(projectSummary),
    nextCursor: projectSummary.nullable(),
  }),
});

/** Same conversation paging boundary, with the application's top-level visibility rule. */
export const appConversationListRequest = defineRequest({
  direction: "client-to-server",
  method: "app.conversations.list",
  params: conversationListRequest.params,
  result: conversationListRequest.result,
});
