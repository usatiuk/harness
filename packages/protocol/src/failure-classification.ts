import { TransientModelFailure, parseRetryAfterMs } from "./model.ts";
import type { ModelFailureReason } from "./model.ts";

/**
 * Provider-agnostic transient/permanent classification skeleton for transport
 * failures, run at the adapter boundary where response headers and error bodies
 * are still available. Providers contribute only their tables and hooks
 * ({@link ClassifyTransientFailureOptions}); everything the classifier does not
 * recognize is permanent and rethrown unchanged by the caller. Aborts and
 * cancellation are never transient.
 */

/** The shreds of a provider/SDK error the classifier and its hooks read. */
export interface ErrorShape {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  type?: unknown;
  headers?: unknown;
  body?: unknown;
  error?: unknown;
  cause?: unknown;
}

export function asShape(error: unknown): ErrorShape {
  return typeof error === "object" && error !== null ? error : {};
}

export function messageOf(error: unknown): string | undefined {
  const { message } = asShape(error);
  if (typeof message === "string" && message) return message;
  return undefined;
}

/** Recognized Node/undici transport failures on the error or its cause chain. */
const NETWORK_REASONS: Record<string, ModelFailureReason> = {
  ETIMEDOUT: "timeout",
  ERR_SOCKET_CONNECTION_TIMEOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  UND_ERR_SOCKET_CONNECTION_TIMEOUT: "timeout",
  ECONNREFUSED: "connection",
  ECONNRESET: "connection",
  ENOTFOUND: "connection",
  EAI_AGAIN: "connection",
  ENETUNREACH: "connection",
  EHOSTUNREACH: "connection",
  EPIPE: "connection",
  UND_ERR_CONNECT: "connection",
  UND_ERR_SOCKET: "connection",
  UND_ERR_CLOSED: "connection",
};

/**
 * The error's identity: SDK error classes (OpenAI, Anthropic) leave `name` as
 * `"Error"` and carry the class name on `constructor.name` (verified against
 * the installed SDKs); DOMExceptions and plain fakes carry it on `name`.
 */
function errorKind(error: unknown): string | undefined {
  const { name } = asShape(error);
  if (typeof name === "string" && name && name !== "Error") return name;
  const kind = (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor
    ?.name;
  return typeof kind === "string" && kind && kind !== "Error" ? kind : undefined;
}

const ABORT_KINDS: ReadonlySet<string> = new Set(["AbortError", "APIUserAbortError"]);

function isAbortLike(error: unknown): boolean {
  const kind = errorKind(error);
  return kind !== undefined && ABORT_KINDS.has(kind);
}

/** SDK transport error class names mapped to retry reasons. */
const TRANSPORT_REASONS: Record<string, ModelFailureReason> = {
  APIConnectionTimeoutError: "timeout",
  TimeoutError: "timeout",
  APIConnectionError: "connection",
};

/** Fetch/network-level failures: SDK connection errors, undici `TypeError("fetch failed")`
 * with its coded cause, and recognized Node transport codes. */
function networkReason(error: unknown): ModelFailureReason | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let messageFallback: ModelFailureReason | undefined;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 4; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const shape = asShape(current);
    const kind = errorKind(current);
    if (kind !== undefined && Object.hasOwn(TRANSPORT_REASONS, kind))
      return TRANSPORT_REASONS[kind];
    if (typeof shape.code === "string" && Object.hasOwn(NETWORK_REASONS, shape.code)) {
      return NETWORK_REASONS[shape.code];
    }
    // Undici's bare TypeError("fetch failed") names no reason of its own; use
    // it only when no coded cause in the chain gives a more precise one.
    if (
      messageFallback === undefined &&
      current instanceof TypeError &&
      typeof shape.message === "string" &&
      /fetch failed|network|socket/i.test(shape.message)
    ) {
      messageFallback = "connection";
    }
    current = shape.cause;
  }
  return messageFallback;
}

/** HTTP status to retry reason: a plain table, or a custom lookup for tables
 * that cannot be enumerated (e.g. any 5xx gateway failure). */
export type StatusReasons =
  | Readonly<Record<number, ModelFailureReason>>
  | ((status: number) => ModelFailureReason | undefined);

/** Per-provider tables and hooks for {@link classifyTransientFailure}. Absent
 * axes simply never classify. */
export interface ClassifyTransientFailureOptions {
  /** Body/SDK error `type` codes mapped to retry reasons; consulted before status. */
  typeReasons?: Readonly<Record<string, ModelFailureReason>> | undefined;
  /** HTTP statuses mapped to retry reasons. */
  statusReasons?: StatusReasons | undefined;
  /** Provider-specific predicate for billing/quota codes that stay permanent
   * even on HTTP 429. */
  isPermanentQuotaCode?: ((code: string) => boolean) | undefined;
  /** Provider-requested wait extracted from the failure (headers or body). */
  retryAfterMsOf?: ((error: unknown) => number | undefined) | undefined;
  /** Cancellation of the logical call; an aborted signal is never classified. */
  signal?: AbortSignal | undefined;
}

/**
 * Provider-requested wait from response headers: `retry-after-ms` (integer
 * milliseconds) first, then `Retry-After` (delta-seconds or HTTP-date).
 * Unparseable values are omitted so the retry middleware falls back to its own
 * backoff. Pass as `retryAfterMsOf` for providers that state their wait in
 * headers.
 */
export function retryAfterMsFromHeaders(error: unknown): number | undefined {
  const { headers } = asShape(error);
  const get = (headers as { get?: unknown } | null | undefined)?.get;
  if (typeof get !== "function") return undefined;
  const read = (name: string): string | null =>
    (get as (name: string) => string | null).call(headers, name);
  const millis = read("retry-after-ms")?.trim();
  if (millis && /^\d+$/.test(millis)) return Number(millis);
  return parseRetryAfterMs(read("retry-after"));
}

function quotaExhausted(shape: ErrorShape, isPermanent: (code: string) => boolean): boolean {
  const body = asShape(shape.error);
  const nested = asShape(body.error);
  return [shape.code, shape.type, body.code, body.type, nested.code, nested.type].some(
    (code) => typeof code === "string" && isPermanent(code),
  );
}

/** The retry reason for one failure: the body/SDK `type` table first (the SDK
 * surfaces the raw body's `error.error.type` as `type`; fall back to the raw
 * body), then the status table. */
function reasonFor(
  shape: ErrorShape,
  options: ClassifyTransientFailureOptions,
): ModelFailureReason | undefined {
  const typeReasons = options.typeReasons;
  if (typeReasons) {
    const type = [shape.type, asShape(asShape(shape.error).error).type].find(
      (value): value is string => typeof value === "string" && Object.hasOwn(typeReasons, value),
    );
    if (type !== undefined) return typeReasons[type];
  }
  const { status } = shape;
  const statusReasons = options.statusReasons;
  if (typeof status !== "number" || !statusReasons) return undefined;
  return typeof statusReasons === "function" ? statusReasons(status) : statusReasons[status];
}

/**
 * Classifies one transport failure into a `TransientModelFailure`, or returns
 * `undefined` when the failure is permanent (or the call was cancelled), in
 * which case the caller rethrows the original error unchanged.
 */
export function classifyTransientFailure(
  error: unknown,
  options: ClassifyTransientFailureOptions = {},
): TransientModelFailure | undefined {
  if (options.signal?.aborted || isAbortLike(error)) return undefined;
  const shape = asShape(error);
  const message = messageOf(error);
  const failureOptions = (
    retryAfterMs: number | undefined,
  ): ErrorOptions & { retryAfterMs?: number; message?: string } => ({
    cause: error,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  const network = networkReason(error);
  if (network) return new TransientModelFailure(network, failureOptions(undefined));
  const reason = reasonFor(shape, options);
  if (!reason) return undefined;
  if (
    shape.status === 429 &&
    options.isPermanentQuotaCode &&
    quotaExhausted(shape, options.isPermanentQuotaCode)
  ) {
    return undefined;
  }
  return new TransientModelFailure(reason, failureOptions(options.retryAfterMsOf?.(error)));
}
