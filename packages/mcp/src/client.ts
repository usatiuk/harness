import { z } from "zod";
import { defineRequest, jsonValueSchema } from "@harness/protocol";
import { mcpConfigSchema } from "./config.ts";
export * from "./config.ts";
const configWireSchema = z.preprocess((value, ctx) => {
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  return parsed.data;
}, jsonValueSchema);
export const MCP_CLIENT_CONTRACT_VERSION = 1;
const server = z.strictObject({ serverId: z.string() });
export const mcpStatusSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["disabled", "ready", "auth-required", "unavailable"]),
  detail: z.string().nullable(),
  toolCount: z.number().int().nonnegative(),
  authenticated: z.boolean(),
  signingIn: z.boolean(),
  credentials: z.array(z.strictObject({ slot: z.string(), present: z.boolean() })),
});
export const mcpSettingsGet = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.settings.get",
  params: z.strictObject({}),
  result: z.strictObject({
    config: configWireSchema,
    active: z.array(mcpStatusSchema),
    restartRequired: z.boolean(),
    credentialBackend: z.string().nullable(),
  }),
});
export const mcpSettingsSet = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.settings.set",
  params: z.strictObject({ config: configWireSchema }),
  result: z.strictObject({ restartRequired: z.literal(true) }),
});
export const mcpToolsList = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.tools.list",
  params: z.strictObject({}),
  result: z.array(
    z.strictObject({
      serverId: z.string(),
      name: z.string(),
      rawName: z.string(),
      description: z.string(),
      readOnly: z.boolean(),
    }),
  ),
});
export const mcpTest = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.test",
  params: server,
  result: mcpStatusSchema,
});
export const mcpCredentialSet = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.credentials.set",
  params: z.strictObject({
    serverId: z.string(),
    slot: z.string().min(1).max(128),
    value: z.string().min(1),
  }),
  result: z.null(),
});
export const mcpCredentialDelete = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.credentials.delete",
  params: z.strictObject({ serverId: z.string(), slot: z.string().min(1).max(128) }),
  result: z.null(),
});
export const mcpAuthStart = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.auth.start",
  params: server,
  result: z.strictObject({ attemptId: z.string(), url: z.string(), redirectUrl: z.string() }),
});
export const mcpAuthComplete = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.auth.complete",
  params: z.strictObject({ attemptId: z.string(), callbackUrl: z.url() }),
  result: z.null(),
});
export const mcpAuthCancel = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.auth.cancel",
  params: z.strictObject({ attemptId: z.string() }),
  result: z.null(),
});
export const mcpAuthLogout = defineRequest({
  direction: "client-to-server",
  method: "plugin.mcp.auth.logout",
  params: server,
  result: z.null(),
});
export const mcpRpcMessages = [
  mcpSettingsGet,
  mcpSettingsSet,
  mcpToolsList,
  mcpTest,
  mcpCredentialSet,
  mcpCredentialDelete,
  mcpAuthStart,
  mcpAuthComplete,
  mcpAuthCancel,
  mcpAuthLogout,
] as const;
export type McpSettingsData = z.infer<typeof mcpSettingsGet.result>;
export type McpToolInfo = z.infer<typeof mcpToolsList.result>[number];
