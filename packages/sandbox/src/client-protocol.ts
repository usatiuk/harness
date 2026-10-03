import { z } from "zod";
import { defineNotification, defineRequest } from "@harness/protocol";

export const SANDBOX_CLIENT_CONTRACT_VERSION = 1;

export const sandboxStateSchema = z.strictObject({
  conversationId: z.string(),
  backend: z.enum(["local", "native", "docker"]),
  containerActive: z.boolean(),
});

export const sandboxSnapshotSchema = z.strictObject({
  members: z.array(sandboxStateSchema),
});

export const sandboxEventNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.sandbox.event",
  params: z.strictObject({
    rootConversationId: z.string(),
    conversationId: z.string(),
    phase: z.enum(["build", "create", "postCreate", "ready", "error", "warning"]),
    message: z.string().nullable(),
  }),
});

const sandboxControlParams = z.strictObject({ conversationId: z.string() });
const sandboxControlResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("done"), state: sandboxStateSchema }),
  z.strictObject({ status: z.literal("not-docker") }),
]);

export const sandboxRebuildRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.sandbox.rebuild",
  params: sandboxControlParams,
  result: sandboxControlResult,
});

export const sandboxStopRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.sandbox.stop",
  params: sandboxControlParams,
  result: sandboxControlResult,
});

export type SandboxState = z.infer<typeof sandboxStateSchema>;
export type SandboxSnapshot = z.infer<typeof sandboxSnapshotSchema>;
