import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { TransientModelFailure, type ModelFailureReason } from "@harness/protocol";
import type { ModelCallContext, ModelRequest } from "@harness/protocol";
import { classifyTransientFailure } from "./errors.ts";
import { OpenCodeGoProvider } from "./provider.ts";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

/** A documented openai SDK `APIError` shape: status, headers, JSON body, derived code/type. */
function apiError(
  status: number,
  body: { code?: string | null; type?: string; message?: string } = {},
  headers: Record<string, string> = {},
): Error {
  return new OpenAI.APIError(status, body, undefined, new Headers(headers));
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
    name: "any other 5xx gateway failure stays a transient server failure",
    error: apiError(507),
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
    {
      name: "an already-classified TransientModelFailure is not re-wrapped",
      error: new TransientModelFailure("connection", {
        cause: new TypeError("fetch failed"),
      }),
    },
  ];

  it.each(permanentCases)("leaves $name unchanged (permanent)", ({ error, signal }) => {
    expect(classifyTransientFailure(error, signal)).toBeUndefined();
  });
});

type Family = "chat" | "responses" | "messages";

const FAMILIES: Family[] = ["chat", "responses", "messages"];

const MODELS: Record<Family, string> = {
  chat: "deepseek-v4-pro",
  responses: "gpt-5.6-luna",
  messages: "minimax-m3",
};

function requestFor(family: Family): ModelRequest {
  return {
    instructions: [],
    items: [],
    modelConfig: { provider: "opencode-go", model: MODELS[family] },
  };
}

function providerFor(error: Error): OpenCodeGoProvider {
  const reject = () => Promise.reject(error);
  return new OpenCodeGoProvider({
    openai: {
      client: async () =>
        ({
          chat: { completions: { create: reject } },
          responses: { create: reject },
        }) as never,
    },
    anthropic: { client: async () => ({ messages: { create: reject } }) as never },
  });
}

function streamFor(family: Family, error: Error, signal = new AbortController().signal) {
  return consume(providerFor(error).stream(requestFor(family), signal, CALL_CONTEXT));
}

describe("provider classification", () => {
  it.each(FAMILIES)(
    "throws TransientModelFailure for a gateway rate limit through the %s transport",
    async (family) => {
      const error = apiError(429, { code: "rate_limit_error" }, { "retry-after": "12" });
      await expect(streamFor(family, error)).rejects.toMatchObject({
        name: "TransientModelFailure",
        reason: "rate_limit",
        retryAfterMs: 12_000,
        cause: error,
      });
    },
  );

  it.each(FAMILIES)(
    "rethrows permanent failures unchanged through the %s transport",
    async (family) => {
      const error = apiError(400, { code: "invalid_request_error" });
      await expect(streamFor(family, error)).rejects.toBe(error);
    },
  );

  it.each(FAMILIES)("keeps a billing 429 permanent through %s", async (family) => {
    const error = apiError(429, { code: "insufficient_quota" }, { "retry-after": "7" });
    await expect(streamFor(family, error)).rejects.toBe(error);
  });

  it.each(FAMILIES)("never classifies cancellation through the %s transport", async (family) => {
    const error = apiError(503);
    const controller = new AbortController();
    controller.abort();
    await expect(streamFor(family, error, controller.signal)).rejects.toBe(error);
  });

  it("classifies a 5xx status the shared SDK transports leave unmapped", async () => {
    const error = apiError(507);
    await expect(streamFor("chat", error)).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "server",
      cause: error,
    });
  });

  it("classifies a raw fetch failure at the provider boundary", async () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    await expect(streamFor("responses", error)).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "connection",
      cause: error,
    });
  });
});

describe("real gateway SDK responses", () => {
  for (const status of [429, 501, 507]) {
    it.each(FAMILIES)(
      `keeps quota permanent before the raw %s SDK classifies HTTP ${status}`,
      async (family) => {
        const body = {
          error: { type: "rate_limit_error", code: "insufficient_quota", message: "add credits" },
        };
        const fetch = async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json", "retry-after": "1" },
          });
        const openai = new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch });
        const anthropic = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch });
        const provider = new OpenCodeGoProvider({
          openai: { client: async () => openai },
          anthropic: { client: async () => anthropic },
        });
        await expect(
          consume(provider.stream(requestFor(family), new AbortController().signal, CALL_CONTEXT)),
        ).rejects.toBeInstanceOf(family === "messages" ? Anthropic.APIError : OpenAI.APIError);
      },
    );
  }
});

describe("gateway fallback and SDK identities", () => {
  it.each(FAMILIES)("retains the all-5xx rule through %s", async (family) => {
    const fetch = async () =>
      new Response(JSON.stringify({ error: { message: "gateway unavailable" } }), {
        status: 501,
        headers: { "content-type": "application/json", "retry-after": "3" },
      });
    const openai = new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch });
    const anthropic = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch });
    const provider = new OpenCodeGoProvider({
      openai: { client: async () => openai },
      anthropic: { client: async () => anthropic },
    });
    await expect(
      consume(provider.stream(requestFor(family), new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "server",
      retryAfterMs: 3000,
      cause: expect.any(family === "messages" ? Anthropic.APIError : OpenAI.APIError) as unknown,
    });
  });
  it.each([
    new OpenAI.APIConnectionTimeoutError(),
    new Anthropic.APIConnectionTimeoutError(),
    new OpenAI.APIConnectionError({
      cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    }),
    new Anthropic.APIConnectionError({
      cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    }),
  ])("classifies actual SDK timeout identity and cause", (error) => {
    expect(classifyTransientFailure(error)?.reason).toBe("timeout");
  });
  it.each([new OpenAI.APIUserAbortError(), new Anthropic.APIUserAbortError()])(
    "preserves actual SDK abort identity",
    (error) => {
      Object.assign(error, {
        status: 503,
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      });
      expect(classifyTransientFailure(error)).toBeUndefined();
    },
  );
});
