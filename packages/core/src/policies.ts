import type { ContextPolicy, ToolMiddleware } from "@harness/protocol";

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

/**
 * Caps each text block of the tool's result. Ships as the default *innermost*
 * middleware so it bounds raw tool output; contributed middlewares wrap outside it,
 * so e.g. LSP diagnostics appended afterwards are not truncated. Spilling raw output
 * to a blob is a later middleware.
 */
export function truncateMiddleware(maxChars = 10_000): ToolMiddleware {
  return {
    id: "truncate",
    async wrap(call, _ctx, next) {
      const result = await next(call);
      const forModel = result.forModel.map((block) =>
        block.type === "text" && block.text.length > maxChars
          ? { type: "text" as const, text: `${block.text.slice(0, maxChars)}…[truncated]` }
          : block,
      );
      return { ...result, forModel };
    },
  };
}
