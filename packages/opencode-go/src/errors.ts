import {
  classifyTransientFailure as classify,
  retryAfterMsFromHeaders,
  TransientModelFailure,
} from "@harness/protocol";
import { isPermanentQuotaCode } from "@harness/openai-core";
import type { ModelFailureReason } from "@harness/protocol";

/**
 * Transient/permanent classification for OpenCode Go fetch/SSE transport
 * failures, performed at the adapter boundary where the raw response headers
 * are still available. The shared openai/anthropic transports classify their
 * SDK-shaped errors first and pass permanent failures through unchanged, so
 * this classifier sees each error after them: an already-classified
 * `TransientModelFailure` is rethrown as is and known OpenAI billing codes stay
 * permanent even on HTTP 429. Everything this classifier does not recognize is
 * permanent and rethrown unchanged by the caller. Aborts and cancellation are
 * never transient.
 */

/**
 * Statuses that always mean a transient provider-side failure here: 408 request
 * timeouts, 429 rate limits, and any 5xx gateway failure. The Go gateway speaks
 * plain gateway statuses; SDK-shaped 529 overload is mapped by the shared
 * transports before it reaches this boundary.
 */
function statusReason(status: number): ModelFailureReason | undefined {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "server";
  return undefined;
}

/**
 * Classifies one transport failure into a `TransientModelFailure`, or returns
 * `undefined` when the failure is permanent (or the call was cancelled), in
 * which case the caller rethrows the original error unchanged. A failure that
 * already crossed a shared transport classifier is rethrown unchanged as well:
 * re-wrapping it would nest the original failure under a new cause and drop the
 * provider wait it carries.
 */
export function classifyTransientFailure(
  error: unknown,
  signal?: AbortSignal,
): TransientModelFailure | undefined {
  if (error instanceof TransientModelFailure) return undefined;
  return classify(error, {
    statusReasons: statusReason,
    isPermanentQuotaCode,
    retryAfterMsOf: retryAfterMsFromHeaders,
    signal,
  });
}
