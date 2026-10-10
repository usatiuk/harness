import { z } from "zod";
import { defineRequest } from "@harness/protocol";
import { versionSchema } from "@harness/release";

const common = {
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
};
export const localHostSchema = z.strictObject({
  ...common,
  kind: z.literal("local"),
  id: z.literal("local"),
});
export const remoteHostSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("wsl"),
    distribution: z.string().min(1),
    user: z.string().min(1).nullable(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("ssh"),
    destination: z
      .string()
      .regex(/^[A-Za-z0-9_.@:[\]-]+$/u)
      .refine((value) => !value.startsWith("-")),
  }),
]);
export const hostSchema = z.discriminatedUnion("kind", [
  localHostSchema,
  ...remoteHostSchema.options,
]);
export type Host = z.infer<typeof hostSchema>;
export type RemoteHost = z.infer<typeof remoteHostSchema>;
/** Display metadata does not change the execution account. */
export function sameExecutionTarget(left: Host, right: Host): boolean {
  if (left.kind === "local") return right.kind === "local";
  if (left.kind === "ssh") return right.kind === "ssh" && left.destination === right.destination;
  return (
    right.kind === "wsl" && left.distribution === right.distribution && left.user === right.user
  );
}
export const LOCAL_HOST = { kind: "local", id: "local", label: "Local" } satisfies Host;
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
  desktop: { keepServerRunning: false },
});

export const serverIdentitySchema = z.strictObject({
  managementVersion: z.literal(1),
  productVersion: versionSchema,
  serverId: z.uuid(),
  instanceId: z.uuid(),
  protocolVersion: z.number().int().positive(),
  home: z.string().min(1),
  pid: z.number().int().positive(),
  platform: z.enum(["win32", "darwin", "linux"]),
  buildId: z.string().min(1),
});
export type ServerIdentity = z.infer<typeof serverIdentitySchema>;
export const managementInspectRequest = defineRequest({
  direction: "client-to-server",
  method: "management.inspect",
  params: z.strictObject({}),
  result: serverIdentitySchema,
});
export const managementStopRequest = defineRequest({
  direction: "client-to-server",
  method: "management.stop",
  params: z.strictObject({ instanceId: z.uuid(), ifIdle: z.boolean().default(false) }),
  result: z.strictObject({ accepted: z.boolean() }),
});
export const managementReleaseRequest = defineRequest({
  direction: "client-to-server",
  method: "management.release",
  params: z.strictObject({ instanceId: z.uuid() }),
  result: z.strictObject({ stopping: z.boolean() }),
});
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
  transferred: z.boolean(),
});
export type PreparedRuntime = z.infer<typeof preparedRuntimeSchema>;
export const hostConnectionTargetSchema = z.union([
  z.strictObject({ host: localHostSchema, runtime: z.null() }),
  z.strictObject({ host: remoteHostSchema, runtime: preparedRuntimeSchema }),
]);
export type HostConnectionTarget = z.infer<typeof hostConnectionTargetSchema>;
export const connectionCommandSchema = z.union([
  z.strictObject({ type: z.literal("config.read") }),
  z.strictObject({ type: z.literal("host.save"), host: hostSchema }),
  z.strictObject({ type: z.literal("host.remove"), id: z.string() }),
  z.strictObject({ type: z.literal("host.select"), id: z.string() }),
  z.strictObject({ type: z.literal("preferences"), keepServerRunning: z.boolean() }),
  z.strictObject({ type: z.literal("wsl.list") }),
  z.strictObject({ type: z.literal("desktop.exit"), identity: serverIdentitySchema }),
  z.strictObject({ type: z.literal("runtime.prepare"), host: remoteHostSchema }),
  z.strictObject({
    type: z.literal("server.stop"),
    host: localHostSchema,
    identity: serverIdentitySchema,
    runtime: z.null(),
  }),
  z.strictObject({
    type: z.literal("server.stop"),
    host: remoteHostSchema,
    identity: serverIdentitySchema,
    runtime: preparedRuntimeSchema,
  }),
]);
export type ConnectionCommand = z.infer<typeof connectionCommandSchema>;
export type ClientConfigCommand = Extract<
  ConnectionCommand,
  {
    type: "config.read" | "host.save" | "host.remove" | "host.select" | "preferences";
  }
>;
const commandResults = {
  "config.read": clientConfigSchema,
  "host.save": clientConfigSchema,
  "host.remove": clientConfigSchema,
  "host.select": clientConfigSchema,
  preferences: clientConfigSchema,
  "wsl.list": z.array(z.string()),
  "runtime.prepare": preparedRuntimeSchema,
  "server.stop": z.null(),
  "desktop.exit": z.null(),
} satisfies Record<ConnectionCommand["type"], z.ZodType>;
export type ConnectionCommandResult<C extends ConnectionCommand> = z.infer<
  (typeof commandResults)[C["type"]]
>;
/** The native IPC boundary validates a result once before callers use it. */
export function parseConnectionCommandResult<C extends ConnectionCommand>(
  command: C,
  value: unknown,
): ConnectionCommandResult<C> {
  return commandResults[command.type].parse(value) as ConnectionCommandResult<C>;
}
