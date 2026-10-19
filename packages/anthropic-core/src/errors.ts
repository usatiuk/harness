import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import {
  asShape,
  messageOf,
  networkFailureReason,
  retryAfterMsFromHeaders,
  TransientModelFailure,
} from "@harness/protocol";
import type { ModelFailureReason } from "@harness/protocol";

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

/** Normalize the native SDK error once; gateway subclasses own their quota policy. */
export function classifyTransientFailure(
  error: unknown,
  signal?: AbortSignal,
): TransientModelFailure | undefined {
  if (
    signal?.aborted ||
    error instanceof APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    error instanceof TransientModelFailure
  )
    return undefined;
  const shape = asShape(error);
  const bodyType = asShape(asShape(shape.error).error).type;
  if (shape.type === "billing_error" || bodyType === "billing_error") return undefined;
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
  if (!reason) {
    const body = asShape(shape.error);
    for (const type of [shape.type, asShape(body.error).type]) {
      if (typeof type === "string" && Object.hasOwn(TYPE_REASONS, type)) {
        reason = TYPE_REASONS[type];
        break;
      }
    }
  }
  if (!reason && typeof shape.status === "number") reason = STATUS_REASONS[shape.status];
  if (!reason) return undefined;
  const message = messageOf(error);
  const retryAfterMs = retryAfterMsFromHeaders(error);
  return new TransientModelFailure(reason, {
    cause: error,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
