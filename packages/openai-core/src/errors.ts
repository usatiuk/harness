import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import {
  asShape,
  messageOf,
  networkFailureReason,
  retryAfterMsFromHeaders,
  TransientModelFailure,
} from "@harness/protocol";
import type { ModelFailureReason } from "@harness/protocol";

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
function isPermanentQuotaCode(code: string): boolean {
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

/** OpenAI SDKs lift code/type; compatible gateways can retain the raw envelope. */
export function isPermanentQuotaFailure(error: unknown): boolean {
  const shape = asShape(error);
  const body = asShape(shape.error);
  const nested = asShape(body.error);
  return [shape.code, shape.type, body.code, body.type, nested.code, nested.type].some(
    (code) => typeof code === "string" && isPermanentQuotaCode(code),
  );
}

/** Statusless APIError failures thrown by the SDK's SSE decoder. */
const SSE_REASONS: Record<string, ModelFailureReason> = {
  rate_limit_error: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  server_error: "server",
  service_unavailable_error: "server",
  server_is_overloaded: "server",
};

/** Normalize once while SDK identity, machine codes and response headers survive. */
export function classifyTransientFailure(
  error: unknown,
  signal?: AbortSignal,
): TransientModelFailure | undefined {
  if (
    signal?.aborted ||
    error instanceof APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    error instanceof TransientModelFailure ||
    isPermanentQuotaFailure(error)
  )
    return undefined;

  const shape = asShape(error);
  let reason: ModelFailureReason | undefined;
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  ) {
    reason = "timeout";
  } else {
    reason = networkFailureReason(error);
    if (!reason && error instanceof APIConnectionError) reason = "connection";
  }
  if (!reason && typeof shape.status === "number") reason = STATUS_REASONS[shape.status];
  if (!reason && error instanceof APIError && shape.status === undefined) {
    const body = asShape(shape.error);
    for (const code of [shape.type, shape.code, body.type, body.code]) {
      if (typeof code === "string" && Object.hasOwn(SSE_REASONS, code)) {
        reason = SSE_REASONS[code];
        break;
      }
    }
  }
  if (!reason) return undefined;
  const message = messageOf(error);
  const retryAfterMs = retryAfterMsFromHeaders(error);
  return new TransientModelFailure(reason, {
    cause: error,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
