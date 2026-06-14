import type { CompactionStrategy, Item, ToolMiddleware } from "@harness/protocol";

/** The default when no plugin contributes a strategy: never fold. */
export const noCompaction: CompactionStrategy = {
  async compact() {
    return null;
  },
};

/**
 * Bounds a chain at its latest compaction: the summary stands for everything before
 * it, so context starts there. Context-build and the compaction pass both slice
 * through here, so they agree on the window by construction.
 */
export function compactedWindow(items: Item[]): Item[] {
  const i = items.findLastIndex((item) => item.type === "compaction");
  return i === -1 ? items : items.slice(i);
}

/**
 * Caps each text block of the tool's result, but only when there is no execution backend to spill
 * to a file — otherwise the output-bounding middleware preserves the full output, so this defers.
 */
export function truncateMiddleware(maxChars = 10_000): ToolMiddleware {
  return {
    id: "truncate",
    async wrap(call, ctx, next) {
      const result = await next(call);
      if (ctx.execution) return result; // a file host exists ⇒ defer to the output-bounding policy
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
