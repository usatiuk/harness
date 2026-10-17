import { randomUUID } from "node:crypto";
import { textOf, type Plugin, type ToolMiddleware } from "@harness/protocol";
import { boundView, executionOf } from "@harness/execution";

/** Above this many bytes of text, a one-shot result is spilled to a file instead of shown inline. */
const SPILL_BYTES = 16 * 1024;
const VIEW = { maxLines: 200, maxLineBytes: 1024, maxTotalBytes: 16 * 1024, mode: "head" as const };

/**
 * Preserves oversized one-shot tool output: spills the full text to a workspace file and shows a
 * head view + pointer. Skips `addressableOutput` tools (they narrow their own named file) and calls
 * with no execution backend (the core `truncate` floor caps those).
 */
export function outputBoundMiddleware(): ToolMiddleware {
  return {
    id: "output-bound",
    async wrap(call, ctx, next) {
      const result = await next(call);
      if (ctx.toolMeta(call.name)?.addressableOutput || !ctx.service("execution")) return result;
      const full = textOf(result.forModel);
      if (Buffer.byteLength(full, "utf8") <= SPILL_BYTES) return result;

      const id = `out_${randomUUID().slice(0, 8)}`;
      const path = await executionOf(ctx).outputStore(ctx.conversationId).put(id, full);
      return {
        ...result,
        forModel: [
          { type: "text", text: boundView(full, VIEW) },
          {
            type: "text",
            text: `…[output truncated; full output preserved at ${path} — read it with an available file tool]`,
          },
          ...result.forModel.filter((block) => block.type === "image"),
        ],
      };
    },
  };
}

/** Contributes the output-bounding policy. Independent of activities; needs an execution backend. */
export const outputPlugin: Plugin = {
  id: "output",
  toolMiddleware: () => [outputBoundMiddleware()],
};
