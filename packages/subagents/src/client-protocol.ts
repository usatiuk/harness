import { z } from "zod";
import { defineRequest } from "@harness/protocol";

export const SUBAGENTS_CLIENT_CONTRACT_VERSION = 1;

export const subagentsTopLevelRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.subagents.topLevel",
  params: z.strictObject({ conversationIds: z.array(z.string()).max(100) }),
  result: z.strictObject({ conversationIds: z.array(z.string()) }),
});
