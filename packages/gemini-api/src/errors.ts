import { asShape, classifyTransientFailure as classify, messageOf } from "@harness/protocol";
import type { ModelFailureReason, TransientModelFailure } from "@harness/protocol";

/**
 * Transient/permanent classification for `@google/genai` transport failures at
 * the adapter boundary. The SDK retries are disabled (maxRetries: 0), so this
 * classification alone decides what a logical retry may re-issue. Google's
 * `INVALID_ARGUMENT` (including input-token-limit failures) and auth/not-found
 * statuses are permanent; `RESOURCE_EXHAUSTED` and server statuses are
 * transient. Aborts and cancellation are never transient.
 */

/** `ApiError.status` is the numeric HTTP code;400/401/403/404 stay permanent. */
const STATUS_REASONS: Record<number, ModelFailureReason> = {
  408: "timeout",
  429: "rate_limit",
  500: "server",
  502: "server",
  503: "server",
  504: "server",
};

/** The JSON error body out of a message or body string; tolerate a text prefix. */
function errorBody(text: string | undefined): unknown {
  if (!text) return undefined;
  for (const candidate of [text, text.slice(text.indexOf("{"))]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next trivially parseable shape.
    }
  }
  return undefined;
}

/**
 * `google.rpc.RetryInfo`-like `retryDelay` ("12s") from the structured error
 * details, parsed only for plain `Ns`/`N.NNNs` durations; anything else is
 * omitted so the retry middleware falls back to its own backoff. Both SDK error
 * shapes qualify as trivially present: the legacy `ApiError` stringifies the
 * body into `message`, while the Interactions `APIError` family keeps it in
 * `body`/`error`.
 */
function retryAfterMsOf(error: unknown): number | undefined {
  const shape = asShape(error);
  const bodies = [
    errorBody(messageOf(error)),
    errorBody(typeof shape.body === "string" ? shape.body : undefined),
    shape.error,
  ];
  for (const candidate of bodies) {
    const body = candidate as { error?: { details?: unknown }; details?: unknown } | undefined;
    const details = body?.error?.details ?? body?.details;
    if (!Array.isArray(details)) continue;
    for (const entry of details) {
      const retryDelay = (entry as { retryDelay?: unknown } | null)?.retryDelay;
      if (typeof retryDelay !== "string") continue;
      const duration = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(retryDelay);
      if (duration?.[1] !== undefined) return Math.round(Number(duration[1]) * 1000);
    }
  }
  return undefined;
}

/**
 * Classifies one transport failure into a `TransientModelFailure`, or returns
 * `undefined` when the failure is permanent (or the call was cancelled), in
 * which case the caller rethrows the original error unchanged.
 */
export function classifyTransientFailure(
  error: unknown,
  signal?: AbortSignal,
): TransientModelFailure | undefined {
  return classify(error, {
    statusReasons: STATUS_REASONS,
    retryAfterMsOf,
    signal,
  });
}
