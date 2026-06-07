import type { ConversationId, Item, Store } from "@harness/protocol";

const isToolCall = (item: Item): item is Extract<Item, { type: "tool_call" }> =>
  item.type === "tool_call";

/**
 * The entire crash-recovery story. Crash ends the session; on reload the log is
 * read-only history. A trailing `tool_call` with no result gets a synthetic error
 * result so the transcript stays prompt-legal, and any still-`running` turn is
 * marked `failed`. Nothing resumes or re-runs.
 */
export async function reconcileConversation(
  store: Store,
  conversationId: ConversationId,
): Promise<void> {
  const items = await store.listItems(conversationId);

  const answered = new Set(items.filter((i) => i.type === "tool_result").map((i) => i.callId));
  const dangling = items.filter(isToolCall).filter((call) => !answered.has(call.callId));

  for (const call of dangling) {
    await store.appendItem({
      conversationId,
      turnId: call.turnId,
      type: "tool_result",
      callId: call.callId,
      content: [{ type: "text", text: "interrupted: session ended" }],
      status: "error",
    });
  }

  const active = await store.getActiveTurn(conversationId);
  if (active) {
    await store.updateTurn({ id: active.id, status: "failed" });
  }
}
