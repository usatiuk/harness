import { z } from "zod";
import { defineNotification, defineRequest } from "@harness/protocol";

const model = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  preset: z.string().nullable(),
});
const effect = z.enum(["allow", "ask", "deny"]);
const settings = z.strictObject({
  model: model.nullable(),
  approval: z.strictObject({ inWorkspace: effect, outOfWorkspace: effect }),
  sandbox: z.enum(["local", "native", "docker"]),
});
const provider = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["api-key", "oauth"]),
  authenticated: z.boolean(),
  detail: z.string().nullable(),
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
    providers: z.array(provider),
  }),
});
export const appSettingsUpdateRequest = defineRequest({
  direction: "client-to-server",
  method: "app.settings.update",
  params: settings,
  result: z.null(),
});
export const appAuthLoginRequest = defineRequest({
  direction: "client-to-server",
  method: "app.auth.login",
  params: z.strictObject({ provider: z.string(), key: z.string().nullable() }),
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
  params: z.strictObject({ url: z.string().url() }),
});
export type AppSettings = z.infer<typeof appSettingsRequest.result>;
