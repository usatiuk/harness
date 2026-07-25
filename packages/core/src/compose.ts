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
  RequestHandler,
  RequestMiddleware,
  RequestMiddlewareContext,
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

/** Folds request middleware around the terminal host/UI handler, enforcing at-most-once `next`. */
export function runRequestChain(
  mws: readonly RequestMiddleware[],
  request: Parameters<RequestHandler>[0],
  ctx: RequestMiddlewareContext,
  terminal: RequestHandler,
): Promise<unknown> {
  const build = (i: number): RequestHandler => {
    if (i === mws.length) return terminal;
    return (req) => {
      let called = false;
      const next: RequestHandler = (inner) => {
        if (called) {
          return Promise.reject(new Error(`request middleware '${mws[i]!.id}' called next twice`));
        }
        called = true;
        return build(i + 1)(inner);
      };
      return mws[i]!.wrap(req, ctx, next);
    };
  };
  return build(0)(request);
}
