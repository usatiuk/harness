import OpenAI from "openai";
import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { describe, expect, it, vi } from "vitest";
import { TransientModelFailure, type ModelFailureReason } from "@harness/protocol";
import type { ModelCallContext, ModelRequest } from "@harness/protocol";
import { classifyTransientFailure } from "./errors.ts";
import { OpenAIChatTransport, OpenAIResponsesProvider } from "./provider.ts";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;
const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "openai", model: "gpt-5.1" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

/** A documented openai SDK `APIError` shape: status, headers, JSON body, derived code/type.
 * `error` in the body models raw, unlifted gateway bodies (`{ error: { … } }`). */
function apiError(
  status: number,
  body: { code?: string | null; type?: string; message?: string; error?: unknown } = {},
  headers: Record<string, string> = {},
): Error {
  return new APIError(status, body, undefined, new Headers(headers));
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
    name: "429 rate limit with retry-after-ms preferred over Retry-After",
    error: apiError(
      429,
      { code: "rate_limit_error" },
      { "retry-after-ms": "1500", "retry-after": "9" },
    ),
    reason: "rate_limit",
    retryAfterMs: 1500,
  },
  {
    name: "429 rate limit with delta-seconds Retry-After",
    error: apiError(429, { code: "rate_limit_error" }, { "retry-after": "7" }),
    reason: "rate_limit",
    retryAfterMs: 7000,
  },
  {
    name: "429 rate limit with fractional Retry-After",
    error: apiError(429, {}, { "retry-after": "0.5" }),
    reason: "rate_limit",
    retryAfterMs: 500,
  },
  {
    name: "429 rate limit with unparseable headers omits retryAfterMs",
    error: apiError(429, {}, { "retry-after": "soon", "retry-after-ms": "later" }),
    reason: "rate_limit",
    retryAfterMs: undefined,
  },
  {
    name: "429 rate limit without headers omits retryAfterMs",
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
    name: "503 stays server even with an overload signal",
    error: apiError(503, { code: "server_is_overloaded" }),
    reason: "server",
  },
  {
    name: "504 gateway timeout",
    error: apiError(504),
    reason: "server",
  },
  {
    name: "529 is overloaded",
    error: apiError(529),
    reason: "overloaded",
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

  it("parses an HTTP-date Retry-After against the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const failure = classifyTransientFailure(
        apiError(429, {}, { "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }),
      );
      expect(failure?.retryAfterMs).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits a past HTTP-date wait instead of a negative floor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    try {
      const failure = classifyTransientFailure(
        apiError(429, {}, { "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }),
      );
      expect(failure?.retryAfterMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const permanentCases: { name: string; error: unknown; signal?: AbortSignal }[] = [
    { name: "400 invalid request", error: apiError(400, { code: "invalid_request_error" }) },
    {
      name: "400 context overflow is left to the transport mapping",
      error: apiError(400, { code: "context_length_exceeded" }),
    },
    { name: "401 authentication error", error: apiError(401) },
    { name: "403 permission denied", error: apiError(403) },
    { name: "404 not found", error: apiError(404) },
    { name: "413 payload too large", error: apiError(413) },
    { name: "422 unprocessable entity", error: apiError(422) },
    { name: "409 conflict", error: apiError(409) },
    ...[
      "credit_balance_exhausted",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
      "insufficient_quota",
    ].map((code) => ({
      name: `429 billing code ${code} is permanent`,
      error: apiError(429, { code, type: code }),
    })),
    {
      name: "429 billing code nested in the body error",
      error: apiError(429, { type: "insufficient_quota" }),
    },
    {
      name: "429 billing code only on the raw body's inner error",
      error: apiError(429, { error: { code: "insufficient_quota", type: "insufficient_quota" } }),
    },
    {
      name: "429 a new billing code stays permanent via the billing_ family",
      error: apiError(429, {
        code: "billing_hard_limit_reached",
        type: "billing_hard_limit_reached",
      }),
    },
    {
      name: "429 terminated access stays permanent",
      error: apiError(429, { code: "access_terminated", type: "access_terminated" }),
    },
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
      error: apiError(503),
      signal: AbortSignal.abort(),
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

describe("transport classification", () => {
  const transientError = () =>
    apiError(429, { code: "rate_limit_error" }, { "retry-after-ms": "1200" });

  const responsesTransport = (error: Error) =>
    new OpenAIResponsesProvider({
      credentials: {
        client: async () =>
          ({ responses: { create: async () => Promise.reject(error) } }) as unknown as OpenAI,
      },
    });

  const chatTransport = (error: Error) =>
    new OpenAIChatTransport({
      provider: "openai",
      credentials: {
        client: async () =>
          ({
            chat: { completions: { create: async () => Promise.reject(error) } },
          }) as unknown as OpenAI,
      },
    });

  const transports: [string, (error: Error) => OpenAIResponsesProvider | OpenAIChatTransport][] = [
    ["responses", responsesTransport],
    ["chat", chatTransport],
  ];

  it.each(transports)(
    "throws TransientModelFailure through the %s transport",
    async (_family, build) => {
      const error = transientError();
      await expect(
        consume(build(error).stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
      ).rejects.toMatchObject({
        name: "TransientModelFailure",
        reason: "rate_limit",
        retryAfterMs: 1200,
        cause: error,
      });
    },
  );

  it.each(transports)(
    "rethrows permanent failures unchanged through the %s transport",
    async (_family, build) => {
      const error = apiError(429, { code: "insufficient_quota" }, { "retry-after": "7" });
      await expect(
        consume(build(error).stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
      ).rejects.toBe(error);
    },
  );

  it.each(transports)(
    "never classifies cancellation through the %s transport",
    async (_family, build) => {
      const error = apiError(503);
      const controller = new AbortController();
      controller.abort();
      await expect(
        consume(build(error).stream(REQUEST, controller.signal, CALL_CONTEXT)),
      ).rejects.toBe(error);
    },
  );
});

describe("SDK SSE failures", () => {
  const transient = [
    { type: "server_error", code: "server_error", reason: "server" },
    { type: "rate_limit_error", code: "rate_limit_exceeded", reason: "rate_limit" },
  ];
  for (const family of ["chat", "responses"] as const) {
    it.each(transient)(
      `classifies a pre-first-event ${family} $type`,
      async ({ type, code, reason }) => {
        const client = new OpenAI({
          apiKey: "test-key",
          maxRetries: 0,
          fetch: async () =>
            new Response(
              `event: error\ndata: ${JSON.stringify({ error: { type, code, message: "try later" } })}\n\n`,
              {
                headers: { "content-type": "text/event-stream", "retry-after": "2" },
              },
            ),
        });
        const credentials = { client: async () => client };
        const provider =
          family === "chat"
            ? new OpenAIChatTransport({ provider: "openai", credentials })
            : new OpenAIResponsesProvider({ credentials });
        await expect(
          consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
        ).rejects.toMatchObject({
          name: "TransientModelFailure",
          reason,
          retryAfterMs: 2000,
          cause: expect.any(APIError) as unknown,
          message: "try later",
        });
      },
    );
    it(`keeps a statusless ${family} quota failure permanent`, async () => {
      const client = new OpenAI({
        apiKey: "test-key",
        maxRetries: 0,
        fetch: async () =>
          new Response(
            `event: error\ndata: ${JSON.stringify({ error: { type: "server_error", code: "insufficient_quota", message: "add credits" } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const credentials = { client: async () => client };
      const provider =
        family === "chat"
          ? new OpenAIChatTransport({ provider: "openai", credentials })
          : new OpenAIResponsesProvider({ credentials });
      await expect(
        consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
      ).rejects.toBeInstanceOf(APIError);
    });
  }
  it("quota wins over status and a transport cause", () => {
    const error = Object.assign(
      new APIError(503, { code: "insufficient_quota" }, undefined, new Headers()),
      {
        cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      },
    );
    expect(classifyTransientFailure(error)).toBeUndefined();
  });
  it("prefers the actual timeout cause over a generic SDK connection wrapper", () => {
    const error = new APIConnectionError({
      cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    });
    expect(classifyTransientFailure(error)?.reason).toBe("timeout");
  });
  it("does not infer transience from an unwrapped fetch-failed message", () => {
    expect(
      classifyTransientFailure(
        new TypeError("fetch failed", { cause: new Error("unknown scheme") }),
      ),
    ).toBeUndefined();
  });
  it("uses SDK connection identity when the SDK wraps an unknown fetch failure", async () => {
    const raw = new TypeError("fetch failed", { cause: new Error("unknown scheme") });
    const client = new OpenAI({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => {
        throw raw;
      },
    });
    const error = await client.responses
      .create({ model: "test", input: "go" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(classifyTransientFailure(error)).toMatchObject({ reason: "connection", cause: error });
  });
});
