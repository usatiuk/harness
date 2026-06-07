import type { ConversationId, Item, Store } from "@harness/protocol";

const isToolCall = (item: Item): item is Extract<Item, { type: "tool_call" }> =>
  item.type === "tool_call";

/**
 * Crash recovery: close each dangling `tool_call` with a synthetic error result so
 * the transcript stays prompt-legal, and fail any stale `running` turn. No resume.
 *
 * Assumes the store's "at most one running turn" invariant, so one `getActiveTurn`
 * collapses the stale turn. Idempotency under concurrent durable-store reconcilers
 * is a store constraint (unique `(conversationId, callId)` tool_result +
 * compare-and-set turn status), not application logic.
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
    await store.updateTurn(active.id, "failed");
  }
}
