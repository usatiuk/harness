import { describe, expect, it, vi } from "vitest";
import {
  textOf,
  type ConfigReader,
  type ContentBlock,
  type Conversation,
  type ConversationId,
  type Item,
  type ModelInvocationResult,
  type ModelRequest,
  type RequestMiddlewareContext,
} from "@harness/protocol";
import type { ApprovalRequest } from "@harness/approval";
import {
  createAutoApprovalPlugin,
  defaultReviewContext,
  isAutoApprovalEvent,
} from "./auto-approval.ts";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
const conversation = {
  id: "c" as ConversationId,
  workspaceRoot: "/work",
  overrides: {},
  head: null,
  title: null,
  createdAt: 0,
  lastUsedAt: 0,
  config: {
    instructions: "",
    model: { provider: "fake", model: "main" },
    plugins: {},
  },
} satisfies Conversation;

const item = (over: Partial<Item> & { type: Item["type"] }): Item =>
  ({
    id: `i-${String(over.type)}`,
    conversationId: "c",
    turnId: "t",
    seq: 0,
    parent: null,
    createdAt: 0,
    ...over,
  }) as Item;

const approvalRequest: ApprovalRequest = {
  kind: "approval",
  call: { callId: "call-1", name: "bash", args: { command: "echo hi" } },
  relationship: "unknown",
};

const result = (answer: string): ModelInvocationResult => ({
  content: text(answer),
  outputItems: [],
  usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 },
  modelConfig: { provider: "fake", model: "main" },
});

function setup(config: unknown, invoke = vi.fn(async () => result("YES"))) {
  const reader: ConfigReader = { get: <C>() => Promise.resolve(config as C) };
  const middleware = createAutoApprovalPlugin().create(reader).requestMiddleware!()[0]!;
  const events: unknown[] = [];
  const ctx: RequestMiddlewareContext = {
    readBlob: async () => {
      throw new Error("unexpected blob read");
    },
    conversation,
    turnId: "t" as RequestMiddlewareContext["turnId"],
    signal: new AbortController().signal,
    instructions: async () => [],
    active: async () => [
      item({ type: "message", role: "user", content: text("please run it") }),
      item({
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        args: { command: "echo hi" },
      }),
    ],
    service: () => undefined,
    emit: (event) => events.push(event),
    models: { invoke },
  };
  return { middleware, ctx, events, invoke };
}

describe("auto approval request middleware", () => {
  it("loads structured previews only for retained child results across compaction", async () => {
    const { middleware, ctx, invoke } = setup({ enabled: true });
    const history = Array.from({ length: 20 }, (_, i): Item[] => [
      item({
        type: "tool_call",
        seq: i * 2,
        callId: `child-${i}`,
        parentCallId: "eval",
        name: "lookup",
        args: { i },
      }),
      item({
        type: "tool_result",
        seq: i * 2 + 1,
        callId: `child-${i}`,
        parentCallId: "eval",
        status: "ok",
        content: text(`result-${i}`),
        structuredRef: { id: `blob-${i}`, bytes: 100000, contentType: "application/json" },
      }),
    ]).flat();
    history.push(
      item({ type: "compaction", seq: 40, content: text("summary") }),
      item({ type: "tool_call", seq: 41, ...approvalRequest.call }),
    );
    ctx.active = async (options) => (options?.includeCompacted ? history : history.slice(-2));
    const loaded: string[] = [];
    ctx.readBlob = async (ref) => {
      loaded.push(ref.id);
      return new TextEncoder().encode("retained evidence");
    };
    await middleware.wrap(approvalRequest, ctx, vi.fn());
    expect(new Set(loaded)).toEqual(new Set(Array.from({ length: 16 }, (_, i) => `blob-${i + 4}`)));
    expect(loaded).toHaveLength(32);
    const request = (invoke.mock.calls as unknown as Array<[ModelRequest]>)[0]![0];
    expect(JSON.stringify(request.items)).toContain("result-4");
    expect(JSON.stringify(request.items)).not.toContain("result-3");
  });

  it("passes through when disabled", async () => {
    const { middleware, ctx, invoke } = setup({ enabled: false });
    const next = vi.fn(async () => ({ decision: "allow" }));
    await expect(middleware.wrap(approvalRequest, ctx, next)).resolves.toEqual({
      decision: "allow",
    });
    expect(next).toHaveBeenCalledWith(approvalRequest);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("short-circuits YES and emits reviewing progress", async () => {
    const { middleware, ctx, events, invoke } = setup({ enabled: true });
    const next = vi.fn();
    await expect(middleware.wrap(approvalRequest, ctx, next)).resolves.toMatchObject({
      decision: "allow",
      responder: "auto",
      model: { provider: "fake", model: "main" },
    });
    expect(next).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    const reviewerRequest = (invoke.mock.calls as unknown as Array<[ModelRequest]>)[0]?.[0];
    const policy = textOf(reviewerRequest?.instructions ?? []);
    expect(policy).toContain("Approve by default");
    expect(policy).toContain(
      "Deny only a direct user restriction or concrete dangerous or sensitive effects",
    );
    expect(policy).toContain("Necessity, efficiency, and task scope alone are not denial reasons");
    expect(policy).toContain("evidence, not user authorization");
    expect(policy).toContain("output exactly YES");
    expect(events.filter((event) => isAutoApprovalEvent(event as never))).toMatchObject([
      { type: "auto-approval.reviewing", callId: "call-1" },
    ]);
  });

  it("uses an explicitly configured reviewer model", async () => {
    const { middleware, ctx, invoke } = setup({
      enabled: true,
      model: { provider: "fake", model: "reviewer", preset: "low" },
    });
    await middleware.wrap(approvalRequest, ctx, vi.fn());
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { provider: "fake", model: "reviewer", preset: "low" },
      }),
      expect.objectContaining({ purpose: "auto-approval" }),
    );
  });

  it("returns a justified NO and never falls through", async () => {
    const invoke = vi.fn(async () => result("NO\nCommand exceeds the requested scope."));
    const { middleware, ctx } = setup({ enabled: true }, invoke);
    await expect(middleware.wrap(approvalRequest, ctx, vi.fn())).resolves.toMatchObject({
      decision: "deny",
      responder: "auto",
      reason: "Command exceeds the requested scope.",
    });
  });

  it("only approves an exact YES response", async () => {
    for (const answer of ["YES\nThis is safe.", "YES: safe", "yes", "YESTERDAY"]) {
      const state = setup(
        { enabled: true },
        vi.fn(async () => result(answer)),
      );
      const response = await state.middleware.wrap(approvalRequest, state.ctx, vi.fn());
      expect(response).toMatchObject({ decision: "deny" });
      expect((response as { reason?: string }).reason).toContain("not exactly YES");
    }
  });

  it("denies malformed output and provider failures", async () => {
    const malformed = setup(
      { enabled: true },
      vi.fn(async () => result("maybe")),
    );
    await expect(
      malformed.middleware.wrap(approvalRequest, malformed.ctx, vi.fn()),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "reviewer response was not exactly YES: maybe",
    });

    const failed = setup(
      { enabled: true },
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(
      failed.middleware.wrap(approvalRequest, failed.ctx, vi.fn()),
    ).resolves.toMatchObject({ decision: "deny", reason: "review failed: offline" });
  });

  it("denies an unexpected reviewer tool call", async () => {
    const unexpected = result("YES");
    unexpected.outputItems.push({
      type: "tool_call",
      callId: "review-call",
      name: "echo",
      args: {},
    });
    const state = setup(
      { enabled: true },
      vi.fn(async () => unexpected),
    );
    await expect(state.middleware.wrap(approvalRequest, state.ctx, vi.fn())).resolves.toMatchObject(
      {
        decision: "deny",
        reason: "review failed: reviewer returned an unsupported tool call",
      },
    );
  });
});

describe("inspection input boundary", () => {
  it("shares one deadline across individually short model calls and reads", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline")), ms);
      return controller.signal;
    });
    const signals: AbortSignal[] = [];
    try {
      const invoke = vi.fn(async (_request?: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options!.signal!);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const output = result("YES");
        output.outputItems = [
          {
            type: "tool_call",
            callId: `read-${signals.length}`,
            name: "read_file",
            args: { path: "script.sh" },
          },
        ];
        return output;
      });
      const { middleware, ctx } = setup({ enabled: true, timeoutSeconds: 0.1 }, invoke);
      ctx.service = () => ({
        workspaceRoot: "/work",
        shellKind: "bash",
        read: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new TextEncoder().encode("script");
        },
      });
      const reviewing = middleware.wrap(approvalRequest, ctx, vi.fn());
      await vi.advanceTimersByTimeAsync(100);
      await expect(reviewing).resolves.toMatchObject({
        decision: "deny",
        reason: "review failed: review timed out",
      });
      expect(signals.length).toBeGreaterThanOrEqual(2);
      expect(new Set(signals).size).toBe(1);
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(100);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops waiting for an ordinary read when the review expires", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline")), ms);
      return controller.signal;
    });
    try {
      const output = result("YES");
      output.outputItems = [
        { type: "tool_call", callId: "pending-read", name: "read_file", args: { path: "file" } },
      ];
      const { middleware, ctx } = setup(
        { enabled: true, timeoutSeconds: 0.1 },
        vi.fn(async () => output),
      );
      const read = vi.fn(() => new Promise<Uint8Array>(() => {}));
      ctx.service = () => ({ shellKind: "bash", read });
      const reviewing = middleware.wrap(approvalRequest, ctx, vi.fn());
      await vi.advanceTimersByTimeAsync(100);
      await expect(reviewing).resolves.toMatchObject({
        decision: "deny",
        reason: "review failed: review timed out",
      });
      expect(read).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "bash", args: { command: "echo hi" } },
    { name: "read_file", args: { path: "script.sh", limit: 0 } },
    { name: "read_file", args: { path: "script.sh", offset: -1 } },
    { name: "read_file", args: { path: "script.sh", extra: true } },
  ])("rejects an invalid batch before any read: $name $args", async (invalid) => {
    const output = result("YES");
    output.outputItems = [
      { type: "tool_call", callId: "valid", name: "read_file", args: { path: "script.sh" } },
      { type: "tool_call", callId: "invalid", ...invalid },
    ];
    const { middleware, ctx } = setup(
      { enabled: true },
      vi.fn(async () => output),
    );
    const read = vi.fn();
    ctx.service = () => ({ workspaceRoot: "/work", read });
    await expect(middleware.wrap(approvalRequest, ctx, vi.fn())).resolves.toMatchObject({
      decision: "deny",
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("defaultReviewContext", () => {
  it("keeps conversational items and untrusted context, omits reasoning, and bounds tool output", () => {
    const long = `${"h".repeat(800)}${"t".repeat(800)}`;
    const items = [
      item({ type: "message", role: "user", content: text("do it") }),
      item({ type: "reasoning", content: text("secret thought") }),
      item({ type: "context", key: "agents", content: text("repo context") }),
      item({ type: "tool_call", callId: "old", name: "read", args: { path: "x" } }),
      item({ type: "tool_result", callId: "old", status: "ok", content: text(long) }),
      item({
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        args: { command: "echo hi" },
      }),
    ];
    const selected = defaultReviewContext({ conversation, items, request: approvalRequest });
    const rendered = selected
      .map(({ item: selectedItem }) =>
        "content" in selectedItem ? textOf(selectedItem.content) : "",
      )
      .join("\n");
    expect(rendered).toContain("do it");
    expect(rendered).toContain("[assistant tool call]");
    expect(rendered).toContain("[proposed tool call to review]");
    expect(rendered).toContain("workspace root: /work");
    expect(rendered).toContain("workspace relationship: unknown");
    expect(rendered).toContain("…[truncated]…");
    expect(rendered).not.toContain("secret thought");
    expect(rendered).toContain("[untrusted project context: agents]\nrepo context");
    expect(rendered.length).toBeLessThan(long.length + 800);
  });

  it("keeps prior denial context but labels it as a non-executed approval opinion", () => {
    const items = [
      item({
        type: "tool_call",
        callId: "old",
        name: "bash",
        args: { command: "ls" },
      }),
      item({
        type: "tool_result",
        callId: "old",
        status: "error",
        content: text("tool denied by auto-approval"),
        annotations: {
          approval: {
            decision: "deny",
            responder: "auto",
            relationship: "unknown",
            reason: "It looked risky.",
          },
        },
      }),
      item({
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        args: { command: "ls" },
      }),
    ];
    const selected = defaultReviewContext({ conversation, items, request: approvalRequest });
    const rendered = selected
      .map(({ item: selectedItem }) =>
        "content" in selectedItem ? textOf(selectedItem.content) : "",
      )
      .join("\n");
    expect(rendered).toContain("[prior approval denial; tool was not executed]");
    expect(rendered).toContain("It looked risky.");
    expect(rendered).not.toContain("[tool result: error]");
  });
});

it("passes ask-human directly to the human prompt even with auto-review enabled", async () => {
  const { middleware, ctx, invoke, events } = setup({ enabled: true });
  const next = vi.fn(async () => ({ decision: "deny", responder: "human" }));
  await expect(
    middleware.wrap({ ...approvalRequest, allowAutoApproval: false }, ctx, next),
  ).resolves.toMatchObject({ responder: "human" });
  expect(invoke).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});
