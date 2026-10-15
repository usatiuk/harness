import type { Conversation, Plugin } from "@harness/protocol";
import { LocalExecutionContext } from "./local.ts";

/**
 * Contributes the local filesystem/child-process substrate as a per-conversation service
 * under the `"execution"` key. Keys are unique host-wide, so this stays the single execution
 * backend; tools narrow it via `executionOf`.
 */
export const localExecutionPlugin: Plugin = {
  id: "local-execution",
  services: () => [
    {
      key: "execution",
      scope: "workspace",
      for: (conversation: Conversation) => new LocalExecutionContext(conversation.workspaceRoot),
    },
  ],
};
