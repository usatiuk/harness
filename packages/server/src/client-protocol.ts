import { z } from "zod";
import { defineNotification, defineRequest } from "@harness/protocol";

const model = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  preset: z.string().nullable(),
});
import {
  toolPermissionSchema as effect,
  humanApprovalTimeoutSchema,
} from "@harness/approval/client";
const settings = z.strictObject({
  model: model.nullable(),
  approval: z.strictObject({
    inWorkspace: effect,
    outOfWorkspace: effect,
    humanApprovalTimeoutSeconds: humanApprovalTimeoutSchema,
  }),
  autoApproval: z.strictObject({ enabled: z.boolean(), model: model.nullable() }),
  sandbox: z.enum(["local", "native", "docker"]),
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
  params: settings,
  result: z.null(),
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
