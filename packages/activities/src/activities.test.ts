import { describe, expect, it } from "vitest";
import type {
  ContentBlock,
  ConversationId,
  ModelMiddlewareContext,
  ModelRequest,
  ToolContext,
  ToolMiddlewareContext,
  ToolResult,
} from "@harness/protocol";
import {
  ActivityManager,
  backgroundInjectMiddleware,
  consume,
  consumeMiddleware,
  type Activity,
  type ActivityResult,
} from "./index.ts";

const text = (blocks: ContentBlock[]): string =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** A controllable Activity: settle its `done` on demand. */
function fakeActivity(id: string): { activity: Activity; settle: (r: ActivityResult) => void } {
  let settle!: (r: ActivityResult) => void;
  const done = new Promise<ActivityResult>((res) => (settle = res));
  return {
    activity: { id, kind: "test", title: id, peek: () => [], kill: () => {}, done },
    settle,
  };
}

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "c" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    execution: undefined,
    service: () => undefined,
    emit: () => {},
    deliver: () => {},
    ...over,
  };
}

function fakeMwCtx(over: Partial<ToolMiddlewareContext> = {}): ToolMiddlewareContext {
  return {
    ...fakeCtx(over),
    toolMeta: () => undefined,
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => Promise.resolve({}),
    active: () => Promise.resolve([]),
    appendContext: () => Promise.resolve(),
    ...over,
  };
}

describe("ActivityManager — surface a completion exactly once", () => {
  it("suppresses the proactive notice when a wait is in flight", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const { activity, settle } = fakeActivity("a1");
    mgr.track(activity, { callId: "k1", emit: () => {} });
    const notices: ContentBlock[][] = [];
    mgr.notifyOnExit("a1", (c) => notices.push(c));
    const waiting = mgr.wait("a1", 1000); // registers #waiting synchronously
    settle({ status: "ok", summary: "done", view: [] });
    expect(await waiting).not.toBe("running");
    await tick();
    expect(notices).toHaveLength(0); // the wait owned the surfacing
  });

  it("delivers exactly one proactive notice when never waited", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const { activity, settle } = fakeActivity("a2");
    mgr.track(activity, { callId: "k2", emit: () => {} });
    const notices: ContentBlock[][] = [];
    mgr.notifyOnExit("a2", (c) => notices.push(c));
    settle({ status: "ok", summary: "done", view: [{ type: "text", text: "out" }] });
    await tick();
    expect(notices).toHaveLength(1);
    expect(text(notices[0]!)).toContain("[activity a2]");
  });

  it("emits activity.started on track and activity.exited on settle", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const events: { type: string; id: unknown; status?: unknown }[] = [];
    const { activity, settle } = fakeActivity("a6");
    mgr.track(activity, { callId: "k6", emit: (e) => events.push(e as never) });
    expect(events).toEqual([
      { type: "activity.started", conversationId: "c", id: "a6", kind: "test", title: "a6" },
    ]);
    settle({ status: "error", summary: "boom", view: [] });
    await tick();
    expect(events[1]).toEqual({
      type: "activity.exited",
      conversationId: "c",
      id: "a6",
      status: "error",
      summary: "boom",
    });
  });

  it("claim is one-shot and parallel-call-safe", () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const a = fakeActivity("x").activity;
    const b = fakeActivity("y").activity;
    mgr.track(a, { callId: "ca", emit: () => {} });
    mgr.track(b, { callId: "cb", emit: () => {} });
    expect(mgr.claim("ca")).toBe(a);
    expect(mgr.claim("cb")).toBe(b);
    expect(mgr.claim("ca")).toBeUndefined(); // consumed
  });
});

describe("consume", () => {
  it("backgrounds, returns a started status, and delivers on exit", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const { activity, settle } = fakeActivity("a3");
    mgr.track(activity, { callId: "k", emit: () => {} });
    const delivered: ContentBlock[][] = [];
    const result = await consume(
      mgr,
      activity,
      true,
      fakeCtx({ deliver: (c) => delivered.push(c) }),
    );
    expect(result.status).toBe("ok");
    expect(text(result.forModel)).toContain("activity a3");
    expect(text(result.forModel)).toContain("background");
    settle({ status: "ok", summary: "fin", view: [] });
    await tick();
    expect(delivered).toHaveLength(1);
  });

  it("foreground inlines a fast result", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const { activity, settle } = fakeActivity("a4");
    mgr.track(activity, { callId: "k", emit: () => {} });
    const pending = consume(mgr, activity, false, fakeCtx());
    settle({ status: "error", summary: "boom", view: [{ type: "text", text: "stderr" }] });
    const result = await pending;
    expect(result.status).toBe("error");
    expect(text(result.forModel)).toContain("stderr");
  });
});

describe("consumeMiddleware", () => {
  it("strips background, claims the activity, and owns the result", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const ctx = fakeMwCtx({ service: (k) => (k === "activities" ? mgr : undefined) });
    const next = (call: { callId: string; args: unknown }): Promise<ToolResult> => {
      expect(call.args).toEqual({ command: "x" }); // background was stripped before the tool
      const { activity, settle } = fakeActivity("a5");
      settle({ status: "ok", summary: "s", view: [{ type: "text", text: "yo" }] });
      mgr.track(activity, { callId: call.callId, emit: () => {} });
      return Promise.resolve({ forModel: [{ type: "text", text: "placeholder" }], status: "ok" });
    };
    const result = await consumeMiddleware().wrap(
      { callId: "k1", name: "bash", args: { command: "x", background: false } },
      ctx,
      next,
    );
    expect(text(result.forModel)).toContain("yo");
    expect(text(result.forModel)).not.toContain("placeholder");
  });

  it("passes through a tool that registers no activity", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const ctx = fakeMwCtx({ service: () => mgr });
    const out: ToolResult = { forModel: [{ type: "text", text: "plain" }], status: "ok" };
    const result = await consumeMiddleware().wrap(
      { callId: "z", name: "read", args: {} },
      ctx,
      () => Promise.resolve(out),
    );
    expect(result).toBe(out);
  });
});

describe("backgroundInjectMiddleware", () => {
  it("injects `background` into backgroundable function schemas only", async () => {
    const request: ModelRequest = {
      instructions: [],
      items: [],
      modelConfig: { provider: "x", model: "y" },
      tools: [
        {
          kind: "function",
          name: "bash",
          description: "",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
        {
          kind: "function",
          name: "read",
          description: "",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const ctx: ModelMiddlewareContext = {
      conversationId: "c" as ConversationId,
      signal: new AbortController().signal,
      toolMeta: (name) => (name === "bash" ? { backgroundable: true } : undefined),
    };
    let seen: ModelRequest | undefined;
    // eslint-disable-next-line require-yield
    async function* sink(req: ModelRequest): AsyncGenerator<never> {
      seen = req;
    }
    for await (const _ of backgroundInjectMiddleware().wrap(request, ctx, sink)) void _;

    const find = (name: string): Record<string, unknown> => {
      const tool = seen!.tools!.find((t) => t.name === name)!;
      return (tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters
        .properties;
    };
    expect(find("bash").background).toBeDefined();
    expect(find("bash").command).toBeDefined(); // original args preserved
    expect(find("read").background).toBeUndefined();
  });
});
