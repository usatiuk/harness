import type { CompactionStrategy } from "@harness/protocol";

/**
 * Deterministic test strategy: folds into a single `summary of N items` block once
 * the window holds more than `over` items; otherwise skips.
 */
export function fakeCompaction({ over }: { over: number }): CompactionStrategy {
  return {
    async compact({ build }) {
      const items = build.items.map((entry) => entry.item);
      if (items.length <= over) return null;
      return {
        content: [{ type: "text", text: `summary of ${items.length} items` }],
      };
    },
  };
}
