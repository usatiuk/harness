import { ApiError } from "@google/genai";
import {
  asShape,
  messageOf,
  networkFailureReason,
  retryAfterMsFromHeaders,
  TransientModelFailure,
  type ModelFailureReason,
} from "@harness/protocol";

/**
 * Transient/permanent classification for `@google/genai` transport failures at
 * the adapter boundary. The SDK retries are disabled (maxRetries: 0), so this
 * classification alone decides what a logical retry may re-issue. Google's
 * `INVALID_ARGUMENT` (including input-token-limit failures) and auth/not-found
 * statuses are permanent; `RESOURCE_EXHAUSTED` and server statuses are
 * transient. Aborts and cancellation are never transient.
 */

/** `ApiError.status` is the numeric HTTP code; 400/401/403/404 stay permanent. */
const STATUS_REASONS: Record<number, ModelFailureReason> = {
  408: "timeout",
  429: "rate_limit",
  500: "server",
  502: "server",
  503: "server",
  504: "server",
};

// GenAI 2.28 exports only the legacy ApiError. Its Interactions error classes
// are private and assign name = this.constructor.name; payload builds therefore
// preserve names (scripts/build-payloads.mjs), pinned by a bundled SDK regression.
const INTERACTION_API_ERRORS = new Set([
  "APIError",
  "BadRequestError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "ConflictError",
  "UnprocessableEntityError",
  "RateLimitError",
  "InternalServerError",
]);

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
    shape.error,
    errorBody(typeof shape.body === "string" ? shape.body : undefined),
    ...(error instanceof ApiError ? [errorBody(messageOf(error))] : []),
  ];
  for (const candidate of bodies) {
    const body = candidate as { error?: { details?: unknown }; details?: unknown } | undefined;
    const details = body?.error?.details ?? body?.details;
    if (!Array.isArray(details)) continue;
    for (const entry of details) {
      const detail = entry as { "@type"?: unknown; retryDelay?: unknown } | null;
      if (detail?.["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") continue;
      const retryDelay = detail.retryDelay;
      if (typeof retryDelay !== "string") continue;
      const duration = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(retryDelay);
      if (duration?.[1] !== undefined) {
        const milliseconds = Math.round(Number(duration[1]) * 1000);
        if (Number.isFinite(milliseconds)) return milliseconds;
      }
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
  const shape = asShape(error);
  const name = error instanceof Error ? error.name : undefined;
  if (signal?.aborted || name === "AbortError" || name === "APIUserAbortError") return undefined;
  let reason: ModelFailureReason | undefined;
  if (
    name === "APIConnectionTimeoutError" ||
    (error instanceof DOMException && error.name === "TimeoutError")
  ) {
    reason = "timeout";
  } else {
    // A coded timeout in the original transport cause is more specific than
    // Interactions' generic APIConnectionError wrapper.
    reason = networkFailureReason(error);
    if (!reason && name === "APIConnectionError") reason = "connection";
    if (
      !reason &&
      (error instanceof ApiError || (name !== undefined && INTERACTION_API_ERRORS.has(name))) &&
      typeof shape.status === "number"
    ) {
      reason = STATUS_REASONS[shape.status];
    }
  }
  if (!reason) return undefined;
  const retryAfterMs = retryAfterMsFromHeaders(error) ?? retryAfterMsOf(error);
  const message = messageOf(error);
  return new TransientModelFailure(reason, {
    cause: error,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
