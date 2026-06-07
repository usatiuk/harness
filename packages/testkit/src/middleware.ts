import type { ToolCall, ToolMiddleware, ToolResult } from "@harness/protocol";

const denied = (call: ToolCall): ToolResult => ({
  forModel: [{ type: "text", text: `tool '${call.name}' denied by approval` }],
  status: "error",
});

/** Demo approval gate over the request/respond seam: asks for calls matching `shouldAsk`, denies on `"deny"`. */
export function approvalMiddleware(shouldAsk: (call: ToolCall) => boolean): ToolMiddleware {
  return {
    id: "approval",
    async wrap(call, ctx, next) {
      if (!shouldAsk(call)) return next(call);
      const response = (await ctx.request({ kind: "approval", call })) as { decision?: string };
      return response.decision === "deny" ? denied(call) : next(call);
    },
  };
}
