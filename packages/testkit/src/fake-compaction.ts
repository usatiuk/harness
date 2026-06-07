import type { CompactionStrategy } from "@harness/protocol";

/**
 * Deterministic test strategy: folds into a single `summary of N items` block once
 * the window holds more than `over` items; otherwise skips.
 */
export function fakeCompaction({ over }: { over: number }): CompactionStrategy {
  return {
    async compact({ items }) {
      if (items.length <= over) return null;
      return [{ type: "text", text: `summary of ${items.length} items` }];
    },
  };
}
