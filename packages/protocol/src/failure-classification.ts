import { parseRetryAfterMs } from "./model.ts";
import type { ModelFailureReason } from "./model.ts";

/** Untrusted provider fields inspected only at adapter normalization boundaries. */
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
 * Recognized Node/undici codes through bounded transport wrappers. SDK identity,
 * cancellation and HTTP/body policy belong to adapters, not this helper. Prefer
 * a specific timeout anywhere in the chain over a generic connection wrapper.
 */
export function networkFailureReason(error: unknown): ModelFailureReason | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let connection: ModelFailureReason | undefined;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 4; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const shape = asShape(current);
    if (typeof shape.code === "string" && Object.hasOwn(NETWORK_REASONS, shape.code)) {
      const reason = NETWORK_REASONS[shape.code];
      if (reason === "timeout") return reason;
      connection = reason;
    }
    current = shape.cause;
  }
  return connection;
}

/**
 * Provider-requested wait from response headers: `retry-after-ms` (integer
 * milliseconds) first, then `Retry-After` (delta-seconds or HTTP-date).
 * Unparseable values are omitted so the retry middleware falls back to its own
 * backoff.
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
