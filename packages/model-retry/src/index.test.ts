import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextWindowExceededError,
  ModelInvocationFailure,
  TransientModelFailure,
  type ConversationId,
  type ModelHandler,
  type ModelMiddleware,
  type ModelMiddlewareContext,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";
import {
  MAX_RETRY_DELAY_MS,
  modelRetryPlugin,
  modelRetryConfigSchema,
  retryDelayMs,
} from "./index.ts";
import { modelRetriesSettingsSchema } from "./client.ts";

function createModelRetryMiddleware(config: {
  attempts: number;
  backoffMs: number;
}): ModelMiddleware {
  return modelRetryPlugin.create({ get: async <C>() => config as C }).modelMiddleware!()[0]!;
}

const request: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "fake", model: "fake-1" },
};

type RetryReport = Parameters<ModelMiddlewareContext["reportRetry"]>[0];

function contextOf(controller: AbortController): {
  ctx: ModelMiddlewareContext;
  reported: RetryReport[];
} {
  const reported: RetryReport[] = [];
  const ctx: ModelMiddlewareContext = {
    conversationId: "conv-retry" as ConversationId,
    signal: controller.signal,
    toolMeta: () => undefined,
    reportRetry: (info) => reported.push(info),
  };
  return { ctx, reported };
}

/** Consumes a middleware chain around one scripted handler invocation sequence. */
function run(
  middleware: ModelMiddleware,
  next: ModelHandler,
  ctx: ModelMiddlewareContext,
): Promise<ModelStreamEvent[]> {
  return (async () => {
    const events: ModelStreamEvent[] = [];
    for await (const event of middleware.wrap(request, ctx, next)) events.push(event);
    return events;
  })();
}

/** A handler that fails before yielding anything. Written without a generator:
 * a throw-only generator trips `require-yield`, and the failure is the point. */
const failingNext =
  (failure: Error, onCall?: () => void): ModelHandler =>
  () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        onCall?.();
        return Promise.reject(failure);
      },
    }),
  });

const message = (text: string): ModelStreamEvent[] => [
  { type: "text_delta", text },
  { type: "message", content: [{ type: "text", text }] },
  { type: "completed", usage: null },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("modelRetryConfigSchema", () => {
  it("requires complete settings at the wire boundary without configuration defaults", () => {
    expect(modelRetriesSettingsSchema.parse({ attempts: 3, backoffMs: 50 })).toEqual({
      attempts: 3,
      backoffMs: 50,
    });
    for (const value of [{}, { attempts: 3 }, { backoffMs: 50 }, { attempts: 11, backoffMs: 50 }])
      expect(modelRetriesSettingsSchema.safeParse(value).success).toBe(false);
  });

  it("defaults to five attempts with a one-second backoff", () => {
    expect(modelRetryConfigSchema.parse({})).toEqual({ attempts: 5, backoffMs: 1000 });
    expect(modelRetryConfigSchema.parse({ attempts: 0, backoffMs: 60000 })).toEqual({
      attempts: 0,
      backoffMs: 60000,
    });
    expect(modelRetryConfigSchema.safeParse({ attempts: 11 }).success).toBe(false);
    expect(modelRetryConfigSchema.safeParse({ backoffMs: 49 }).success).toBe(false);
    expect(modelRetryConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("grows the backoff exponentially under full jitter", () => {
    expect(retryDelayMs(1, 1000, 0.5)).toBe(500);
    expect(retryDelayMs(2, 1000, 0.5)).toBe(1000);
    expect(retryDelayMs(3, 1000, 0.5)).toBe(2000);
    expect(retryDelayMs(1, 1000, 0)).toBe(0);
    expect(retryDelayMs(1, 1000, 0.999)).toBeCloseTo(999);
  });

  it("caps the computed backoff and the final wait at one minute", () => {
    // Without the computed cap, attempt 10 would jitter around 1000 × 2^9 ms.
    expect(retryDelayMs(10, 1000, 0.9)).toBe(0.9 * MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(2, 60000, 0.9)).toBe(0.9 * MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(1, 1000, 0, MAX_RETRY_DELAY_MS)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("raises the wait to the provider-requested floor", () => {
    expect(retryDelayMs(1, 1000, 0, 500)).toBe(500);
    expect(retryDelayMs(1, 1000, 0.5, 200)).toBe(500);
  });

  it("forbids retry when the provider asks to wait beyond the cap", () => {
    expect(retryDelayMs(1, 1000, 0, MAX_RETRY_DELAY_MS + 1)).toBeNull();
  });
});

describe("model retry middleware", () => {
  it("re-issues a transient failure before the first event with bounded attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const failures = [
      new TransientModelFailure("rate_limit"),
      new TransientModelFailure("overloaded"),
    ];
    const seen: ModelRequest[] = [];
    let invocation = 0;
    const next: ModelHandler = async function* (req) {
      seen.push(req);
      const failure = failures[invocation++];
      if (failure) throw failure;
      yield* message("recovered");
    };
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const events = await run(createModelRetryMiddleware({ attempts: 3, backoffMs: 50 }), next, ctx);

    expect(events.map((event) => event.type)).toEqual(["text_delta", "message", "completed"]);
    expect(seen).toHaveLength(3);
    // Retries deliver the same logical operation: the identical captured request.
    for (const req of seen) expect(req).toBe(request);
    expect(reported).toEqual([
      { attempt: 2, maxAttempts: 3, delayMs: 25, reason: "rate_limit" },
      { attempt: 3, maxAttempts: 3, delayMs: 50, reason: "overloaded" },
    ]);
  });

  it("rethrows the original failure once attempts are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const failure = new TransientModelFailure("server");
    let calls = 0;
    const next = failingNext(failure, () => calls++);
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const outcome = run(
      createModelRetryMiddleware({ attempts: 3, backoffMs: 50 }),
      next,
      ctx,
    ).catch((error: unknown) => error);

    await expect(outcome).resolves.toBe(failure);
    expect(calls).toBe(3);
    expect(reported).toEqual([
      { attempt: 2, maxAttempts: 3, delayMs: 0, reason: "server" },
      { attempt: 3, maxAttempts: 3, delayMs: 0, reason: "server" },
    ]);
  });

  it.each([
    { label: "unclassified", failure: new Error("billing rejected") },
    { label: "context window", failure: new ContextWindowExceededError("too big") },
  ])("never retries a permanent $label failure", async ({ failure }) => {
    let calls = 0;
    const next = failingNext(failure, () => calls++);
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const outcome = run(
      createModelRetryMiddleware({ attempts: 5, backoffMs: 50 }),
      next,
      ctx,
    ).catch((error: unknown) => error);

    await expect(outcome).resolves.toBe(failure);
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  });

  it("never retries after the first yielded event", async () => {
    const failure = new TransientModelFailure("connection");
    let calls = 0;
    const next: ModelHandler = async function* () {
      calls++;
      yield { type: "text_delta", text: "partial" };
      throw failure;
    };
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const outcome = run(
      createModelRetryMiddleware({ attempts: 5, backoffMs: 50 }),
      next,
      ctx,
    ).catch((error: unknown) => error);

    await expect(outcome).resolves.toBe(failure);
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  });

  it.each([0, 1])("disables retry when attempts is %i", async (attempts) => {
    const failure = new TransientModelFailure("timeout");
    let calls = 0;
    const next = failingNext(failure, () => calls++);
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const outcome = run(createModelRetryMiddleware({ attempts, backoffMs: 50 }), next, ctx).catch(
      (error: unknown) => error,
    );

    await expect(outcome).resolves.toBe(failure);
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  });

  it("floors the jittered delay at the provider-requested wait", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const failure = new TransientModelFailure("rate_limit", { retryAfterMs: 80 });
    let calls = 0;
    const next: ModelHandler = async function* () {
      if (++calls === 1) throw failure;
      yield* message("recovered");
    };
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    await run(createModelRetryMiddleware({ attempts: 2, backoffMs: 1000 }), next, ctx);

    expect(reported).toEqual([{ attempt: 2, maxAttempts: 2, delayMs: 80, reason: "rate_limit" }]);
    expect(calls).toBe(2);
  });

  it("fails fast without reporting when the provider asks to wait beyond the cap", async () => {
    const failure = new TransientModelFailure("rate_limit", {
      retryAfterMs: 60_001,
    });
    let calls = 0;
    const next = failingNext(failure, () => calls++);
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);

    const outcome = run(
      createModelRetryMiddleware({ attempts: 5, backoffMs: 50 }),
      next,
      ctx,
    ).catch((error: unknown) => error);

    await expect(outcome).resolves.toBe(failure);
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  });

  it("stops promptly with the abort failure when aborted during the backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const failure = new TransientModelFailure("rate_limit");
    let calls = 0;
    const next = failingNext(failure, () => calls++);
    const controller = new AbortController();
    const { ctx, reported } = contextOf(controller);
    // Abort mid-backoff: the scheduled wait is 59.4 s, so completing this test proves
    // the sleep is cut short by the abort rather than by its timer.
    const aborting: ModelMiddlewareContext = {
      ...ctx,
      reportRetry: (info) => {
        ctx.reportRetry(info);
        setTimeout(() => controller.abort(), 5);
      },
    };

    const outcome = run(
      createModelRetryMiddleware({ attempts: 2, backoffMs: 60_000 }),
      next,
      aborting,
    ).catch((error: unknown) => error);

    const error = await outcome;
    expect(error).toBeInstanceOf(ModelInvocationFailure);
    expect((error as Error).message).toBe("model invocation aborted");
    expect(calls).toBe(1);
    expect(reported).toEqual([
      { attempt: 2, maxAttempts: 2, delayMs: 59_400, reason: "rate_limit" },
    ]);
  });

  it("does not retry once aborted before the failure surfaces", async () => {
    const failure = new TransientModelFailure("connection");
    const controller = new AbortController();
    controller.abort();
    const { ctx, reported } = contextOf(controller);
    const next = failingNext(failure);

    const outcome = run(
      createModelRetryMiddleware({ attempts: 5, backoffMs: 50 }),
      next,
      ctx,
    ).catch((error: unknown) => error);

    const error = await outcome;
    expect(error).toBeInstanceOf(ModelInvocationFailure);
    expect((error as Error).message).toBe("model invocation aborted");
    expect(reported).toEqual([]);
  });
});
