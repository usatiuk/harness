import type { Conversation } from "./conversation.ts";

/**
 * Plugin seam (contributed via `Plugin.execution`): builds the per-conversation
 * handle placed on `ToolContext.execution`. The kernel calls `for`, caches the
 * result per conversation, and never inspects it — the handle's shape is plugin-tier
 * only (see `@harness/execution`).
 */
export interface ExecutionProvider {
  for(conversation: Conversation): unknown;
}
