import OpenAI, { APIError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelRetryPlugin } from "@harness/model-retry";
import {
  TransientModelFailure,
  type ConversationId,
  type ModelMiddlewareContext,
  type ModelRequest,
} from "@harness/protocol";
import type { CodexAuth } from "./auth.ts";
import { codexCredentials } from "./credentials.ts";
import { CODEX_PROVIDER, createCodexProvider } from "./provider.ts";

const auth = {
  getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
} as unknown as CodexAuth;
const conversationId = "credentials-test" as ConversationId;
const request: ModelRequest = {
  modelConfig: { provider: CODEX_PROVIDER, model: "gpt-5.5" },
  instructions: [],
  items: [],
};
type RetryReport = Parameters<ModelMiddlewareContext["reportRetry"]>[0];

function invoke(reportRetry: ModelMiddlewareContext["reportRetry"]) {
  const controller = new AbortController();
  const provider = createCodexProvider(auth, CODEX_PROVIDER);
  const middleware = modelRetryPlugin.create({
    get: async <C>() => ({ attempts: 3, backoffMs: 50 }) as C,
  }).modelMiddleware!()[0]!;
  return (async () => {
    for await (const event of middleware.wrap(
      request,
      {
        conversationId,
        signal: controller.signal,
        toolMeta: () => undefined,
        reportRetry,
      },
      (req) => provider.stream(req, controller.signal, { conversationId }),
    ))
      void event;
  })().catch((error: unknown) => error);
}

// The SDK error object does not expose statusText or the original Response identity.
async function credentialsResponse(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  const client = await codexCredentials(auth).client(new AbortController().signal);
  return client.fetchWithTimeout("https://example.test/responses", {}, 1000, new AbortController());
}

async function sdkError(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  const client = await codexCredentials(auth).client(new AbortController().signal);
  return client.responses
    .create({ model: "gpt-5.5", input: "test" })
    .catch((error: unknown) => error);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex HTTP errors through credentials, SDK, provider and retry middleware", () => {
  it("surfaces a readable 403 with one request and no retry", async () => {
    const fetch = vi.fn(async () => Response.json({ detail: "Access denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers();
    const reports: RetryReport[] = [];
    const result = invoke((info) => reports.push(info));
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(OpenAI.PermissionDeniedError);
    expect(error).toMatchObject({
      status: 403,
      message: expect.stringContaining("Access denied") as unknown,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });

  it.each([
    {
      response: () =>
        new Response("plain failure", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
      message: "plain failure",
    },
    {
      response: () => Response.json({ error: { message: "normal envelope" } }, { status: 403 }),
      message: "normal envelope",
    },
  ])("does not retry ordinary HTTP errors: $message", async ({ response, message }) => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const reports: RetryReport[] = [];
    const result = invoke((info) => reports.push(info));
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      status: 403,
      message: expect.stringContaining(message) as unknown,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });

  it("honors the transient 429 Retry-After floor before issuing another request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi.fn(async () =>
      Response.json(
        { detail: "Slow down" },
        {
          status: 429,
          headers: { "Retry-After": "2" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const reports: RetryReport[] = [];
    let report!: () => void;
    const reported = new Promise<void>((resolve) => {
      report = resolve;
    });
    const result = invoke((info) => {
      reports.push(info);
      report();
    });
    await reported;
    expect(reports).toEqual([{ attempt: 2, maxAttempts: 3, delayMs: 2000, reason: "rate_limit" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ reason: "rate_limit", retryAfterMs: 2000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      body: { detail: "Wait a while" },
      headers: { "Retry-After": "61" },
      transient: true,
      code: undefined,
      type: undefined,
    },
    {
      body: { detail: "Code-only quota", code: "insufficient_quota" },
      headers: {},
      transient: false,
      code: "insufficient_quota",
      type: undefined,
    },
    {
      body: { detail: "Nested code-only billing", error: { code: "billing_hard_limit_reached" } },
      headers: {},
      transient: false,
      code: "billing_hard_limit_reached",
      type: undefined,
    },
    {
      body: { detail: "Type-only billing", type: "billing_error" },
      headers: {},
      transient: false,
      code: undefined,
      type: "billing_error",
    },
    {
      body: {
        detail: "Top-level quota must survive",
        code: "insufficient_quota",
        error: { code: null },
      },
      headers: {},
      transient: false,
      code: "insufficient_quota",
      type: undefined,
    },
    {
      body: {
        detail: "Top-level billing must survive",
        type: "billing_error",
        error: { type: "rate_limit_error" },
      },
      headers: {},
      transient: false,
      code: undefined,
      type: "billing_error",
    },
    {
      body: {
        detail: "Nested quota must survive",
        code: "rate_limit_exceeded",
        error: { code: "insufficient_quota" },
      },
      headers: {},
      transient: false,
      code: "rate_limit_exceeded",
      type: undefined,
    },
    {
      body: { detail: "Quota exhausted", code: "insufficient_quota", type: "billing_error" },
      headers: {},
      transient: false,
      code: "insufficient_quota",
      type: "billing_error",
    },
    {
      body: {
        detail: "Billing blocked",
        error: {
          code: "billing_hard_limit_reached",
          type: "billing_error",
          param: "account",
          message: "original",
        },
      },
      headers: {},
      transient: false,
      code: "billing_hard_limit_reached",
      type: "billing_error",
    },
  ])(
    "does not retry long waits or permanent quota: $body",
    async ({ body, headers, transient, code, type }) => {
      vi.useFakeTimers();
      const fetch = vi.fn(async () => Response.json(body, { status: 429, headers }));
      vi.stubGlobal("fetch", fetch);
      const reports: RetryReport[] = [];
      const result = invoke((info) => reports.push(info));
      await vi.runAllTimersAsync();
      const error = await result;
      expect(error instanceof TransientModelFailure).toBe(transient);
      expect(error).toMatchObject({ message: expect.stringContaining(body.detail) as unknown });
      if (transient) expect(error).toMatchObject({ retryAfterMs: 61_000, cause: { status: 429 } });
      else expect(error).toMatchObject({ status: 429, type, code });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([]);
    },
  );
});

describe("Codex response normalization", () => {
  it("preserves status, statusText, headers and structured fields while replacing stale body headers", async () => {
    const original = Response.json(
      {
        detail: "Readable detail",
        code: "top-level",
        type: "top-type",
        error: { code: "nested-code", type: "nested-type", param: "account", extra: "retained" },
      },
      {
        status: 429,
        statusText: "Custom limit",
        headers: {
          "Retry-After": "3",
          "x-request-id": "req-test",
          "content-encoding": "gzip",
          "content-length": "1",
        },
      },
    );
    const normalized = await credentialsResponse(original.clone());
    expect(normalized.status).toBe(429);
    expect(normalized.statusText).toBe("Custom limit");
    const error = await sdkError(original);
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    expect(error).toMatchObject({
      status: 429,
      code: "top-level",
      type: "top-type",
      param: "account",
      requestID: "req-test",
      error: { extra: "retained", error: { code: "nested-code", type: "nested-type" } },
      message: expect.stringContaining("Readable detail") as unknown,
    });
    if (!(error instanceof APIError)) throw new Error("Expected SDK APIError");
    const headers = (error as APIError).headers!;
    expect(headers.get("retry-after")).toBe("3");
    expect(headers.has("content-encoding")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
  });

  it.each([
    new Response("plain failure", { status: 403, headers: { "content-type": "text/plain" } }),
    Response.json(
      { error: { message: "normal envelope", code: "normal", type: "normal_type" } },
      { status: 403 },
    ),
    Response.json({ detail: 123, error: { message: "numeric detail" } }, { status: 403 }),
    Response.json({ detail: "", error: { message: "meaningful envelope" } }, { status: 403 }),
    Response.json(null, { status: 403 }),
    Response.json({ detail: "success" }),
  ])(
    "returns the original response unchanged without a string detail HTTP failure",
    async (response) => {
      expect(await credentialsResponse(response)).toBe(response);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      const baselineResponse = response.clone();
      const client = await codexCredentials(auth).client(new AbortController().signal);
      const received = await client.responses
        .create({ model: "gpt-5.5", input: "test" })
        .asResponse()
        .catch((error: unknown) => error);
      if (response.ok) expect(received).toBe(response);
      else {
        expect(received).toBeInstanceOf(OpenAI.PermissionDeniedError);
        // Compare the SDK's own handling, not a second error parser.
        const baseline = new OpenAI({
          apiKey: "test",
          fetch: async () => baselineResponse,
          maxRetries: 0,
        });
        const expected = await baseline.responses
          .create({ model: "gpt-5.5", input: "test" })
          .catch((error: unknown) => error);
        expect(received).toMatchObject({ message: (expected as Error).message });
      }
    },
  );
});
