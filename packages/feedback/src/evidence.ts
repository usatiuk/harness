import {
  jsonValueSchema,
  type Store,
  type ConversationId,
  type ItemId,
  type Item,
} from "@harness/protocol";
import type { FeedbackDecision } from "./client.ts";

export const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
type Output = Item & { reasoningKind?: string };
type Trace = { request?: unknown; nativeRequest?: unknown; limitation?: string };

/** Keep opaque Responses/Anthropic artifacts inside Harness, as in ordinary case capture. */
export function nativeChatRequest(trace: Trace | undefined) {
  const native = trace?.nativeRequest as { messages?: unknown[] } | undefined;
  return Array.isArray(native?.messages) ? jsonValueSchema.parse(native) : null;
}

/** One branch snapshot and invocation index shared by voting and read-only backfill. */
export async function feedbackBranch(store: Store, conversationId: ConversationId, itemId: ItemId) {
  const conversation = await store.getConversation(conversationId);
  if (!conversation) throw new Error("Unknown conversation");
  const selected = await store.getItem(itemId);
  if (
    !selected ||
    !["message", "reasoning", "tool_call"].includes(selected.type) ||
    (selected.type === "message" && selected.role !== "assistant")
  )
    throw new Error("Feedback requires assistant behavior");
  const transcript: Item[] = [];
  let head = conversation.head;
  while (head) {
    const page = await store.listItemAncestors(head, 128);
    transcript.push(...page);
    head = page.at(-1)?.parent ?? null;
    if (Buffer.byteLength(JSON.stringify(transcript)) > MAX_EVIDENCE_BYTES)
      throw new Error("Evidence exceeds 32 MiB; no silent truncation was performed");
  }
  transcript.reverse();
  const selectedIndex = transcript.findIndex((item) => item.id === selected.id);
  if (selectedIndex < 0) throw new Error("Selected item is not on this conversation branch");
  let decision: Item = selected;
  if (decision.type === "tool_call" && decision.parentCallId) {
    const nested = decision;
    decision =
      transcript.find(
        (item) =>
          item.type === "tool_call" &&
          item.callId === nested.parentCallId &&
          item.turnId === nested.turnId,
      ) ?? decision;
  }
  const payloads = await store.getProviderPayloads(
    transcript.filter((item) => item.type === "reasoning").map((item) => item.id),
  );
  const reasoningKinds = new Map(
    payloads.map((payload) => [
      payload.itemId,
      payload.type === "chat_reasoning" ? "exposed_text" : "summary_or_provider_artifact",
    ]),
  );
  const annotatedTranscript: Output[] = transcript.map((item) =>
    item.type === "reasoning"
      ? { ...item, reasoningKind: reasoningKinds.get(item.id) ?? "unknown" }
      : item,
  );
  const links = new Map<string, string>();
  for (const item of annotatedTranscript) {
    if (
      item.type !== "reasoning" &&
      item.type !== "provider_output" &&
      item.type !== "tool_call" &&
      !(item.type === "message" && item.role === "assistant")
    )
      continue;
    const link = (await store.getPluginState(
      "model-evidence",
      item.conversationId,
      `item:${item.id}`,
    )) as { attemptId?: string } | undefined;
    if (link?.attemptId) links.set(item.id, link.attemptId);
  }
  const attemptId = links.get(decision.id);
  const trace = attemptId
    ? ((await store.getPluginState("model-evidence", decision.conversationId, attemptId)) as
        Trace | undefined)
    : undefined;
  return {
    conversation,
    selected,
    decision,
    attemptId,
    trace,
    annotatedTranscript,
    links,
    selectedIndex,
  };
}

/** Added decision context never makes an otherwise valid vote too large to collect. */
export async function feedbackDecisions(
  store: Store,
  branch: Awaited<ReturnType<typeof feedbackBranch>>,
  maxBytes: number,
) {
  const groups = new Map<string, Output[]>();
  let unavailable = 0;
  // Admit attempts at or before the vote, then retain their complete generation:
  // sibling parallel tool calls can be finalized after the selected call.
  for (const item of branch.annotatedTranscript.slice(0, branch.selectedIndex + 1)) {
    const id = branch.links.get(item.id);
    if (id) groups.set(id, []);
    else if (
      item.type === "reasoning" ||
      (item.type === "tool_call" && !item.parentCallId) ||
      (item.type === "message" && item.role === "assistant")
    )
      unavailable++;
  }
  for (const item of branch.annotatedTranscript) {
    const id = branch.links.get(item.id);
    if (id) groups.get(id)?.push(item);
  }
  const decisions: FeedbackDecision[] = [];
  const limitations: string[] = [];
  // Reserve room for the result envelope and bounded omission explanations.
  let remaining = Math.max(0, maxBytes - 1024);
  let omitted = 0;
  for (const [id, outputs] of groups) {
    const trace = (await store.getPluginState("model-evidence", outputs[0]!.conversationId, id)) as
      Trace | undefined;
    const entry: FeedbackDecision = {
      id,
      item_ids: outputs.map((item) => item.id),
      original_outputs: outputs.map((item) => jsonValueSchema.parse(item)),
      native_request: nativeChatRequest(trace),
      limitations: [],
    };
    if (!entry.native_request)
      entry.limitations.push(
        "Captured native chat input unavailable; displayed history is not an exact model input.",
      );
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 > remaining && entry.native_request) {
      entry.native_request = null;
      entry.limitations.push("Captured native chat input omitted to fit the evidence byte limit.");
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > remaining) {
      omitted++;
      continue;
    }
    remaining -= bytes;
    decisions.push(entry);
  }
  if (unavailable)
    limitations.push(
      `${unavailable} assistant output items have no recorded model invocation; their decision inputs are unavailable.`,
    );
  if (omitted)
    limitations.push(`${omitted} recorded decisions omitted to fit the evidence byte limit.`);
  return { decisions, limitations };
}
