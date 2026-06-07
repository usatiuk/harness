import type {
  ToolCall,
  ToolHandler,
  ToolMiddleware,
  ToolMiddlewareContext,
  ToolResult,
} from "@harness/protocol";

/** Folds the chain around `execute`: `mws[0]` is outermost (first inbound, last outbound), `execute` innermost. */
export function runToolChain(
  mws: readonly ToolMiddleware[],
  call: ToolCall,
  ctx: ToolMiddlewareContext,
  execute: ToolHandler,
): Promise<ToolResult> {
  const build = (i: number): ToolHandler =>
    i === mws.length ? execute : (c) => mws[i]!.wrap(c, ctx, build(i + 1));
  return build(0)(call);
}
