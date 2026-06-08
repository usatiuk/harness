import type {
  ModelHandler,
  ModelMiddleware,
  ModelMiddlewareContext,
  ModelRequest,
  ModelStreamEvent,
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

/** Folds the chain around the provider stream: `mws[0]` is outermost, `handler` innermost. */
export function runModelChain(
  mws: readonly ModelMiddleware[],
  request: ModelRequest,
  ctx: ModelMiddlewareContext,
  handler: ModelHandler,
): AsyncIterable<ModelStreamEvent> {
  const build = (i: number): ModelHandler =>
    i === mws.length ? handler : (req) => mws[i]!.wrap(req, ctx, build(i + 1));
  return build(0)(request);
}
