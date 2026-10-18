import type Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { TransientModelFailure, type ModelFailureReason } from "@harness/protocol";
import type { ModelCallContext, ModelRequest } from "@harness/protocol";
import { classifyTransientFailure } from "./errors.ts";
import { AnthropicProvider } from "./provider.ts";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "anthropic", model: "claude-sonnet-4-6" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

/** A documented Anthropic SDK `APIError` shape: the whole body plus its `error.error.type`. */
function apiError(
  status: number,
  type: string | undefined,
  headers: Record<string, string> = {},
  withSdkType = true,
): Error {
  const body = { type: "error", error: { ...(type ? { type } : {}), message: type ?? "failed" } };
  return Object.assign(new Error(`${status} ${type ?? "failed"}`), {
    status,
    headers: new Headers(headers),
    error: body,
    ...(withSdkType && type ? { type } : {}),
  });
}

interface TransientCase {
  name: string;
  error: unknown;
  signal?: AbortSignal | undefined;
  reason: ModelFailureReason;
  retryAfterMs?: number | undefined;
}

const transientCases: TransientCase[] = [
  {
    name: "500 api_error",
    error: apiError(500, "api_error"),
    reason: "server",
  },
  {
    name: "500 with the type only in the body",
    error: apiError(500, "api_error", {}, false),
    reason: "server",
  },
  {
    name: "529 overloaded_error",
    error: apiError(529, "overloaded_error"),
    reason: "overloaded",
  },
  {
    name: "504 timeout_error",
    error: apiError(504, "timeout_error"),
    reason: "timeout",
  },
  {
    name: "504 without a body type maps to timeout",
    error: apiError(504, undefined),
    reason: "timeout",
  },
  {
    name: "429 rate_limit_error with retry-after",
    error: apiError(429, "rate_limit_error", { "retry-after": "12" }),
    reason: "rate_limit",
    retryAfterMs: 12_000,
  },
  {
    name: "429 rate_limit_error prefers retry-after-ms",
    error: apiError(429, "rate_limit_error", { "retry-after-ms": "2500", "retry-after": "9" }),
    reason: "rate_limit",
    retryAfterMs: 2500,
  },
  {
    name: "429 spend cap without retry-after is still a bounded rate_limit retry",
    error: apiError(429, "rate_limit_error"),
    reason: "rate_limit",
    retryAfterMs: undefined,
  },
  {
    name: "503 without a body type",
    error: apiError(503, undefined),
    reason: "server",
  },
  {
    name: "SDK connection error",
    error: new APIConnectionError({ message: "Connection error." }),
    reason: "connection",
  },
  {
    name: "SDK connection timeout error",
    error: new APIConnectionTimeoutError({ message: "Request timed out." }),
    reason: "timeout",
  },
  {
    name: "undici fetch failure with a coded cause",
    error: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    }),
    reason: "connection",
  },
];

const permanentCases: { name: string; error: unknown; signal?: AbortSignal | undefined }[] = [
  { name: "400 invalid_request_error", error: apiError(400, "invalid_request_error") },
  { name: "401 authentication_error", error: apiError(401, "authentication_error") },
  { name: "402 billing_error", error: apiError(402, "billing_error") },
  { name: "403 permission_error", error: apiError(403, "permission_error") },
  { name: "404 not_found_error", error: apiError(404, "not_found_error") },
  { name: "413 request_too_large", error: apiError(413, "request_too_large") },
  {
    name: "user abort error",
    error: new APIUserAbortError({ message: "Request was aborted." }),
  },
  {
    name: "AbortError DOMException",
    error: new DOMException("This operation was aborted", "AbortError"),
  },
  {
    name: "a transient status after the signal fired",
    error: apiError(529, "overloaded_error"),
    signal: AbortSignal.abort(),
  },
];

describe("classifyTransientFailure", () => {
  it.each(transientCases)("classifies $name", ({ error, signal, reason, retryAfterMs }) => {
    const failure = classifyTransientFailure(error, signal);
    expect(failure).toBeInstanceOf(TransientModelFailure);
    expect(failure?.reason).toBe(reason);
    expect(failure?.retryAfterMs).toBe(retryAfterMs);
    expect(failure?.cause).toBe(error);
  });

  it.each(permanentCases)("leaves $name unchanged (permanent)", ({ error, signal }) => {
    expect(classifyTransientFailure(error, signal)).toBeUndefined();
  });
});

describe("AnthropicMessagesTransport classification", () => {
  const transport = (error: Error) =>
    new AnthropicProvider({
      credentials: {
        client: async () =>
          ({ messages: { create: async () => Promise.reject(error) } }) as unknown as Anthropic,
      },
    });

  it("throws TransientModelFailure with the provider wait", async () => {
    const error = apiError(429, "rate_limit_error", { "retry-after": "3" });
    await expect(
      consume(transport(error).stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "rate_limit",
      retryAfterMs: 3000,
      cause: error,
    });
  });

  it("rethrows permanent failures unchanged", async () => {
    const error = apiError(402, "billing_error");
    await expect(
      consume(transport(error).stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toBe(error);
  });

  it("never classifies cancellation", async () => {
    const error = apiError(529, "overloaded_error");
    const controller = new AbortController();
    controller.abort();
    await expect(
      consume(transport(error).stream(REQUEST, controller.signal, CALL_CONTEXT)),
    ).rejects.toBe(error);
  });
});
