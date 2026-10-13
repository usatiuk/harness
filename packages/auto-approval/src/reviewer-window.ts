import { toolCallKey } from "@harness/protocol";
import type { Item } from "@harness/protocol";

/**
 * Keep ordinary context since the latest summary, the last 16 child calls, and
 * the last 16 failed children with their results across the active branch.
 * Main-agent summaries omit children and cannot preserve their approval evidence.
 */
export function reviewerWindow(items: readonly Item[]): Item[] {
  const fold = items.findLastIndex((item) => item.type === "compaction");
  const failures = items
    .filter((item) => item.type === "tool_result" && item.parentCallId && item.status === "error")
    .slice(-16);
  const recent = items.filter((item) => item.type === "tool_call" && item.parentCallId).slice(-16);
  const ids = new Set(
    [...failures, ...recent].map((item) =>
      item.type === "tool_result" || item.type === "tool_call" ? toolCallKey(item) : "",
    ),
  );
  return items.filter((item, index) => {
    if ((item.type === "tool_call" || item.type === "tool_result") && item.parentCallId)
      return ids.has(toolCallKey(item));
    return fold < 0 || index >= fold;
  });
}
