import { randomUUID } from "node:crypto";
import type { Plugin, ToolMiddleware } from "@harness/protocol";
import { BoundedToolOutput, OUTPUT_SPILL_SERVICE, type OpenOutputSpill } from "@harness/core";
import { boundView, executionOf } from "@harness/execution";

const VIEW = { maxLines: 200, maxLineBytes: 1024, maxTotalBytes: 16 * 1024, mode: "head" as const };

const openSpill: OpenOutputSpill = (ctx) => {
  if (!ctx.service("execution")) return undefined;
  const writer = executionOf(ctx).outputStore(ctx.conversationId).open(`out_${randomUUID()}`);
  const write = (text: string) =>
    new Promise<void>((resolve, reject) =>
      writer.write(text, (error) => (error ? reject(error) : resolve())),
    );
  // Encode the concatenated text, even when adjacent blocks split a UTF-16 surrogate pair.
  let carry = "";
  return {
    write: async (chunk) => {
      const text = carry + chunk;
      const last = text.charCodeAt(text.length - 1);
      carry = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
      const ready = carry ? text.slice(0, -1) : text;
      if (ready) await write(ready);
    },
    close: () => writer.close(carry),
    project: (head) => [
      { type: "text", text: boundView(head, VIEW) },
      {
        type: "text",
        text: `…[output truncated; full output preserved at ${writer.path} — read it with an available file tool]`,
      },
    ],
  };
};

/** Only project model-facing output: code must receive the original nested result. */
export function outputBoundMiddleware(): ToolMiddleware {
  return {
    id: "output-bound",
    async wrap(call, ctx, next) {
      const result = await next(call);
      if (
        call.parentCallId ||
        ctx.toolMeta(call.name)?.addressableOutput ||
        !ctx.service("execution")
      )
        return result;
      const output = new BoundedToolOutput(() => openSpill(ctx));
      let content;
      try {
        await output.append(result.forModel);
      } finally {
        content = await output.finish();
      }
      return output.overflow ? { ...result, forModel: content } : result;
    },
  };
}

export const outputPlugin: Plugin = {
  id: "output",
  services: () => [{ key: OUTPUT_SPILL_SERVICE, for: () => openSpill }],
  toolMiddleware: () => [outputBoundMiddleware()],
};
