import { z } from "zod";
import { defineNotification, defineRequest } from "@harness/protocol";

export const WORKSPACE_CLIENT_CONTRACT_VERSION = 1;

export const workspaceShellRunRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.workspace.shell.run",
  params: z.strictObject({
    conversationId: z.string(),
    shellId: z.string(),
    command: z.string(),
  }),
  result: z.null(),
});

export const workspaceShellEventNotification = defineNotification({
  direction: "server-to-client",
  method: "plugin.workspace.shell.event",
  params: z.strictObject({
    rootConversationId: z.string(),
    conversationId: z.string(),
    shellId: z.string(),
    event: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("data"), text: z.string() }),
      z.strictObject({ type: z.literal("exited"), exitCode: z.number().int() }),
    ]),
  }),
});
