import { z } from "zod";
import { defineRequest, HARNESS_PROTOCOL_VERSION } from "@harness/protocol";

const remoteRuntimeSchema = z.strictObject({
  source: z.enum(["managed", "development"]),
});
const common = {
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
};
export const hostSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("local"), id: z.literal("local") }),
  z.strictObject({
    ...common,
    kind: z.literal("wsl"),
    distribution: z.string().min(1),
    user: z.string().min(1).nullable(),
    runtime: remoteRuntimeSchema,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("ssh"),
    destination: z
      .string()
      .regex(/^[A-Za-z0-9_.@:[\]-]+$/u)
      .refine((value) => !value.startsWith("-")),
    runtime: remoteRuntimeSchema,
  }),
]);
export type Host = z.infer<typeof hostSchema>;
export const LOCAL_HOST: Host = { kind: "local", id: "local", label: "Local" };
export const clientConfigSchema = z
  .strictObject({
    version: z.literal(1),
    hosts: z.array(hostSchema).min(1).max(100),
    selectedHostId: z.string().min(1),
    desktop: z.strictObject({ keepServerRunning: z.boolean() }),
  })
  .superRefine((config, ctx) => {
    if (config.hosts.filter((host) => host.kind === "local").length !== 1)
      ctx.addIssue({ code: "custom", message: "Exactly one Local connection is required" });
    if (new Set(config.hosts.map((host) => host.id)).size !== config.hosts.length)
      ctx.addIssue({ code: "custom", message: "Host IDs must be unique" });
    if (!config.hosts.some((host) => host.id === config.selectedHostId))
      ctx.addIssue({ code: "custom", message: "Selected host does not exist" });
  });
export type ClientConfig = z.infer<typeof clientConfigSchema>;
export const defaultClientConfig = (): ClientConfig => ({
  version: 1,
  hosts: [{ ...LOCAL_HOST }],
  selectedHostId: "local",
  desktop: { keepServerRunning: true },
});

export const serverIdentitySchema = z.strictObject({
  serverId: z.uuid(),
  instanceId: z.uuid(),
  protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
  home: z.string().min(1),
  pid: z.number().int().positive(),
  platform: z.enum(["win32", "darwin", "linux"]),
  buildId: z.string().min(1),
});
export type ServerIdentity = z.infer<typeof serverIdentitySchema>;
export const serverInfoRequest = defineRequest({
  direction: "client-to-server",
  method: "server.info",
  params: z.strictObject({}),
  result: serverIdentitySchema,
});
export const serverStopRequest = defineRequest({
  direction: "client-to-server",
  method: "server.stop",
  params: z.strictObject({}),
  result: z.strictObject({ accepted: z.literal(true) }),
});
/** Exit stops an otherwise unobserved local owner without interrupting another client. */
export const serverReleaseRequest = defineRequest({
  direction: "client-to-server",
  method: "server.release",
  params: z.strictObject({}),
  result: z.strictObject({ stopping: z.boolean() }),
});

export const preparedRuntimeSchema = z.strictObject({
  node: z.string().min(1),
  directory: z.string().startsWith("/"),
  home: z.string().startsWith("/"),
  buildId: z.string().regex(/^[a-f0-9]{64}$/u),
  dependencyKey: z.string().regex(/^[a-f0-9]{64}$/u),
  transferred: z.boolean(),
});
export const connectionCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("config.read") }),
  z.strictObject({ type: z.literal("host.save"), host: hostSchema }),
  z.strictObject({ type: z.literal("host.remove"), id: z.string() }),
  z.strictObject({ type: z.literal("host.select"), id: z.string() }),
  z.strictObject({ type: z.literal("preferences"), keepServerRunning: z.boolean() }),
  z.strictObject({ type: z.literal("wsl.list") }),
  z.strictObject({ type: z.literal("desktop.exit"), identity: serverIdentitySchema }),
  z.strictObject({ type: z.literal("runtime.prepare"), host: hostSchema }),
  z.strictObject({
    type: z.literal("server.stop"),
    host: hostSchema,
    identity: serverIdentitySchema,
    runtime: preparedRuntimeSchema.nullable(),
  }),
]);
export type ConnectionCommand = z.infer<typeof connectionCommandSchema>;
