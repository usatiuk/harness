import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransientModelFailure, type ModelFailureReason } from "@harness/protocol";
import type { ModelRequest } from "@harness/protocol";
import { classifyTransientFailure } from "./errors.ts";
import { GeminiProvider } from "./provider.ts";

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  prompt: "go",
  modelConfig: { provider: "gemini", model: "gemini-test" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

const STATUS_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  408: "DEADLINE_EXCEEDED",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

/** A `google.rpc.RetryInfo` detail entry as the SDK stringifies it. */
function retryInfo(retryDelay: string) {
  return { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay };
}

/**
 * A real `@google/genai` `ApiError`: name "ApiError", numeric status, and a
 * message that is the JSON-stringified error body of the failed response.
 */
function apiError(
  status: number,
  fields: { message?: string; details?: unknown[] } = {},
): ApiError {
  return new ApiError({
    status,
    message: JSON.stringify({
      error: {
        code: status,
        message: fields.message ?? "failed",
        status: STATUS_NAMES[status] ?? "UNKNOWN",
        ...(fields.details ? { details: fields.details } : {}),
      },
    }),
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
    name: "408 request timeout",
    error: apiError(408),
    reason: "timeout",
  },
  {
    name: "429 RESOURCE_EXHAUSTED with a RetryInfo retryDelay",
    error: apiError(429, {
      message: "Resource has been exhausted",
      details: [retryInfo("12s")],
    }),
    reason: "rate_limit",
    retryAfterMs: 12_000,
  },
  {
    name: "429 from the streaming error segment with its text prefix",
    error: new ApiError({
      status: 429,
      message: `got status: RESOURCE_EXHAUSTED. ${JSON.stringify({
        error: {
          code: 429,
          message: "Resource has been exhausted",
          status: "RESOURCE_EXHAUSTED",
          details: [retryInfo("1.5s")],
        },
      })}`,
    }),
    reason: "rate_limit",
    retryAfterMs: 1_500,
  },
  {
    name: "429 with a non-duration retryDelay omits retryAfterMs",
    error: apiError(429, { details: [retryInfo("1m")] }),
    reason: "rate_limit",
    retryAfterMs: undefined,
  },
  {
    name: "429 with unrelated details omits retryAfterMs",
    error: apiError(429, {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.DebugInfo",
          detail: "traced",
          retryDelay: "12s",
        },
      ],
    }),
    reason: "rate_limit",
    retryAfterMs: undefined,
  },
  {
    name: "429 without details omits retryAfterMs",
    error: apiError(429),
    reason: "rate_limit",
    retryAfterMs: undefined,
  },
  {
    name: "500 internal server error",
    error: apiError(500),
    reason: "server",
  },
  {
    name: "502 bad gateway",
    error: apiError(502),
    reason: "server",
  },
  {
    name: "503 service unavailable",
    error: apiError(503),
    reason: "server",
  },
  {
    name: "504 gateway timeout",
    error: apiError(504),
    reason: "server",
  },
  {
    name: "undici fetch failure with a coded cause",
    error: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    }),
    reason: "connection",
  },
  {
    name: "undici timeout code on the error",
    error: Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    reason: "timeout",
  },
  {
    name: "socket timeout code on the error",
    error: Object.assign(new TypeError("fetch failed"), { code: "ETIMEDOUT" }),
    reason: "timeout",
  },
  {
    name: "AbortSignal.timeout DOMException",
    error: new DOMException("The operation timed out.", "TimeoutError"),
    reason: "timeout",
  },
];

describe("classifyTransientFailure", () => {
  it.each(transientCases)("classifies $name", ({ error, signal, reason, retryAfterMs }) => {
    const failure = classifyTransientFailure(error, signal);
    expect(failure).toBeInstanceOf(TransientModelFailure);
    expect(failure?.reason).toBe(reason);
    expect(failure?.retryAfterMs).toBe(retryAfterMs);
    expect(failure?.cause).toBe(error);
    expect(failure?.message).toBe((error as Error).message);
  });

  const permanentCases: { name: string; error: unknown; signal?: AbortSignal }[] = [
    {
      name: "400 INVALID_ARGUMENT (including token-limit failures)",
      error: apiError(400, { message: "Input token count exceeds the maximum" }),
    },
    { name: "401 UNAUTHENTICATED", error: apiError(401) },
    { name: "403 PERMISSION_DENIED", error: apiError(403) },
    { name: "404 NOT_FOUND", error: apiError(404) },
    {
      name: "AbortError DOMException",
      error: new DOMException("This operation was aborted", "AbortError"),
    },
    {
      name: "a transient status after the signal fired",
      error: apiError(503),
      signal: AbortSignal.abort(),
    },
    {
      name: "an arbitrary error with a transient status",
      error: Object.assign(new Error("defect"), { status: 503 }),
    },
    {
      name: "an unrecognized TypeError stays a defect, not a connection failure",
      error: new TypeError("cannot read properties of undefined"),
    },
  ];

  it.each(permanentCases)("leaves $name unchanged (permanent)", ({ error, signal }) => {
    expect(classifyTransientFailure(error, signal)).toBeUndefined();
  });
});

describe("gemini transport classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const provider = () =>
    new GeminiProvider({ provider: "gemini", apiKey: "test", models: { "gemini-test": {} } });

  it("throws TransientModelFailure through the provider for a RetryInfo rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 429,
              message: "Resource has been exhausted",
              status: "RESOURCE_EXHAUSTED",
              details: [retryInfo("12s")],
            },
          },
          { status: 429 },
        ),
      ),
    );
    await expect(
      consume(provider().stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "rate_limit",
      retryAfterMs: 12_000,
    });
  });

  it.each([
    [408, "timeout"],
    [429, "rate_limit"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [504, "server"],
  ] as const)("classifies a real Interactions HTTP %i error", async (status, reason) => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code: status, message: "failed", status: STATUS_NAMES[status] } },
        { status, headers: { "retry-after": "2" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      consume(provider().stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({
      reason,
      retryAfterMs: 2000,
      cause: { status },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "the SDK's timeout wrapper without a cause",
      error: () => new DOMException("timed out", "TimeoutError"),
      reason: "timeout",
      sdkName: "APIConnectionTimeoutError",
    },
    {
      name: "a coded timeout below the SDK's generic connection wrapper",
      error: () =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("headers deadline"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
        }),
      reason: "timeout",
      sdkName: "APIConnectionError",
    },
    {
      name: "a bare connection error wrapped by the SDK",
      error: () => new TypeError("fetch failed"),
      reason: "connection",
      sdkName: "APIConnectionError",
    },
  ])("classifies $name", async ({ error, reason, sdkName }) => {
    const fetch = vi.fn(async () => {
      throw error();
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      consume(provider().stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({
      reason,
      cause: { name: sdkName },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the real SDK user-abort wrapper permanent even with a live caller signal", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      consume(provider().stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ name: "APIUserAbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rethrows permanent failures unchanged through the provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 400,
              message: "Input token count exceeds the maximum",
              status: "INVALID_ARGUMENT",
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await consume(provider().stream(REQUEST, new AbortController().signal)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).not.toBeInstanceOf(TransientModelFailure);
    expect(error).toMatchObject({ name: "BadRequestError", status: 400 });
  });

  it("never classifies cancellation through the provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: 503, message: "failed", status: "UNAVAILABLE" } },
          { status: 503 },
        ),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const error = await consume(provider().stream(REQUEST, controller.signal)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).not.toBeInstanceOf(TransientModelFailure);
  });
});
