import { z } from "zod";
import {
  ModelInvocationFailure,
  TransientModelFailure,
  type ConfigReader,
  type ModelHandler,
  type ModelMiddleware,
  type ModelMiddlewareContext,
  type ModelRequest,
  type ModelStreamEvent,
  type PluginDefinition,
} from "@harness/protocol";

/** Effective retry policy under `plugins["model-retry"]` (global scope). `attempts`
 * counts total provider invocations per logical model call; 0/1 disables retry. */
export const modelRetryConfigSchema = z.strictObject({
  attempts: z.number().int().min(0).max(10).default(5),
  backoffMs: z.number().int().min(50).max(60000).default(1000),
});

export type ModelRetryConfig = z.infer<typeof modelRetryConfigSchema>;

/** Fixed bound: a single backoff never outlives one minute, so a turn converges to a
 * visible failure instead of parking on an overload. */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * The wait before re-issuing attempt `failedAttempt` + 1 (1-based): capped exponential
 * backoff (`backoffMs × 2^(failedAttempt−1)`, at most `MAX_RETRY_DELAY_MS`) under full
 * jitter (`random` ∈ [0, 1)), raised to the provider-requested `retryAfterMs` floor.
 * Both waits already stay under the cap: `random * computed` is below the capped
 * backoff, and a longer provider wait surfaces the failure instead. Returns whole
 * milliseconds (integral, like the wire event and the provider-requested wait).
 * Returns `null` when the provider asked to wait beyond the cap — the failure must
 * then surface immediately instead of parking the turn.
 */
export function retryDelayMs(
  failedAttempt: number,
  backoffMs: number,
  random: number,
  retryAfterMs?: number,
): number | null {
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_DELAY_MS) return null;
  const computed = Math.min(MAX_RETRY_DELAY_MS, backoffMs * 2 ** (failedAttempt - 1));
  return Math.round(Math.max(random * computed, retryAfterMs ?? 0));
}

/** A backoff wait that stops promptly when the invocation is aborted, surfacing the
 * engine's abort failure instead of a late provider error. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ModelInvocationFailure("model invocation aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ModelInvocationFailure("model invocation aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function* retryModel(
  config: ModelRetryConfig,
  request: ModelRequest,
  ctx: ModelMiddlewareContext,
  next: ModelHandler,
): AsyncIterable<ModelStreamEvent> {
  const maxAttempts = Math.max(1, config.attempts);
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const event of next(request)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      // Re-issue only a classified transient failure observed before the first yielded
      // event: streamed events cannot be un-emitted, and unclassified failures
      // (including ContextWindowExceededError) are permanent.
      if (yielded || !(error instanceof TransientModelFailure)) throw error;
      // Never retry an aborted invocation, and surface the engine's abort failure.
      if (ctx.signal.aborted) throw new ModelInvocationFailure("model invocation aborted");
      if (attempt >= maxAttempts) throw error;
      const delayMs = retryDelayMs(attempt, config.backoffMs, Math.random(), error.retryAfterMs);
      // A provider-requested wait beyond the cap forbids retry entirely.
      if (delayMs === null) throw error;
      ctx.reportRetry({ attempt: attempt + 1, maxAttempts, delayMs, reason: error.reason });
      await abortableSleep(delayMs, ctx.signal);
    }
  }
}

/** The bounded retry middleware: re-issues `next` only for `TransientModelFailure`
 * before the first yielded event, with capped exponential full-jitter backoff. */
export function createModelRetryMiddleware(config: ModelRetryConfig): ModelMiddleware {
  return {
    id: "model-retry",
    wrap: (request, ctx, next) => retryModel(config, request, ctx, next),
  };
}

export const modelRetryPlugin: PluginDefinition = {
  id: "model-retry",
  configScope: "global",
  configSchema: modelRetryConfigSchema,
  create: (reader: ConfigReader) => ({
    id: "model-retry",
    modelMiddleware: () => [
      {
        id: "model-retry",
        async *wrap(request, ctx, next) {
          const config = await reader.get<z.infer<typeof modelRetryConfigSchema>>(
            "model-retry",
            ctx.conversationId,
          );
          yield* retryModel(config, request, ctx, next);
        },
      },
    ],
  }),
};
