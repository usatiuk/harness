import type { ContextPolicy, OutputProjection, ToolGate } from "@harness/protocol";

/** Selects every item in order; passes the prefix through unchanged. No compaction yet. */
export const defaultContextPolicy: ContextPolicy = {
  async select({ conversationId, instructions, tools, items, payloads }) {
    return {
      conversationId,
      instructions,
      tools,
      items: items.map((item) => {
        const payload = payloads.get(item.id);
        return payload ? { item, payload } : { item };
      }),
    };
  },
};

export const allowAllToolGate: ToolGate = {
  async evaluate() {
    return "allow";
  },
};

/** Caps each text block; spilling raw output to a blob is a later projection. */
export function truncateOutputProjection(maxChars = 10_000): OutputProjection {
  return {
    async project(result) {
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
