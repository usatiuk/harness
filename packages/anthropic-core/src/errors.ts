import { classifyTransientFailure as classify, retryAfterMsFromHeaders } from "@harness/protocol";
import type { ModelFailureReason, TransientModelFailure } from "@harness/protocol";

/**
 * Transient/permanent classification for Anthropic-shaped transport failures,
 * performed at the adapter boundary where response headers are still available.
 * Anthropic spend-cap 429s are indistinguishable from rate limits without body
 * heuristics and are deliberately treated as transient `rate_limit` failures
 * (bounded wasted work). Aborts and cancellation are never transient.
 */

/** Documented Anthropic error types mapped to retry reasons. */
const TYPE_REASONS: Record<string, ModelFailureReason> = {
  rate_limit_error: "rate_limit",
  overloaded_error: "overloaded",
  api_error: "server",
  timeout_error: "timeout",
};

/** Status fallback when the body carries no known error type. 504 is Anthropic's
 * `timeout_error` status and maps to the timeout reason. */
const STATUS_REASONS: Record<number, ModelFailureReason> = {
  408: "timeout",
  429: "rate_limit",
  500: "server",
  502: "server",
  503: "server",
  504: "timeout",
  529: "overloaded",
};

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
    typeReasons: TYPE_REASONS,
    statusReasons: STATUS_REASONS,
    retryAfterMsOf: retryAfterMsFromHeaders,
    signal,
  });
}
