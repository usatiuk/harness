import { classifyTransientFailure as classify, retryAfterMsFromHeaders } from "@harness/protocol";
import type { ModelFailureReason, TransientModelFailure } from "@harness/protocol";

/**
 * Transient/permanent classification for OpenAI-API-shaped transport failures,
 * performed at the adapter boundary where response headers are still available.
 * Everything this classifier does not recognize is permanent and rethrown
 * unchanged by the caller. Aborts and cancellation are never transient.
 */

/**
 * Documented billing/quota codes that never restore by retrying
 * (OpenAI error-code guidance): keep them permanent even on HTTP 429. Shared
 * with the OpenCode Go adapter, whose gateway speaks OpenAI-shaped errors.
 */
const PERMANENT_QUOTA_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

/**
 * Billing and access failures are permanent even on HTTP 429: the account must
 * change before a retry can succeed. Providers introduce these codes faster
 * than lists get maintained (e.g. `billing_hard_limit_reached`), so the whole
 * `billing_` family and terminated access classify permanent by construction.
 */
export function isPermanentQuotaCode(code: string): boolean {
  return (
    PERMANENT_QUOTA_CODES.has(code) || code.startsWith("billing_") || code === "access_terminated"
  );
}

/** Statuses that always mean a transient provider-side failure here. 503 stays
 * `"server"` even with overload signals; 529 is the dedicated overload status. */
const STATUS_REASONS: Record<number, ModelFailureReason> = {
  408: "timeout",
  429: "rate_limit",
  500: "server",
  502: "server",
  503: "server",
  504: "server",
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
    statusReasons: STATUS_REASONS,
    isPermanentQuotaCode,
    retryAfterMsOf: retryAfterMsFromHeaders,
    signal,
  });
}
