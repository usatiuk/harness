import { describe, expect, it, vi } from "vitest";
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
  ActivityWaitTool,
  backgroundContractResolver,
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
    toolContract: () => undefined,
    acceptsToolCall: () => true,
    setResultAnnotation: () => {},
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => Promise.resolve({}),
    active: () => Promise.resolve([]),
    appendContext: () => Promise.resolve(),
    ...over,
  };
}

describe("ActivityManager — surface a completion exactly once", () => {
  it("retains settled entries until pending notices and cancelled waiters release ownership", async () => {
    for (const wait of [false, true]) {
      const mgr = new ActivityManager("c" as ConversationId);
      const controller = new AbortController();
      const { activity, settle } = fakeActivity("watched");
      const notices: ContentBlock[][] = [];
      mgr.track(activity, {
        callId: "watched-call",
        emit: (event) => {
          if (event.type === "activity.exited") {
            if (wait) controller.abort();
            mgr.track(fakeActivity("replacement").activity, {
              callId: "replacement-call",
              emit: () => {},
            });
          }
        },
      });
      for (let i = 0; i < 49; i++)
        mgr.track(fakeActivity(`live-${i}`).activity, { callId: `call-${i}`, emit: () => {} });
      mgr.notifyOnExit(activity.id, (content) => notices.push(content));
      const cancelled = wait
        ? expect(mgr.wait(activity.id, 1000, controller.signal)).rejects.toThrow(/abort/i)
        : undefined;
      settle({ status: "ok", summary: "completed", view: [] });
      if (cancelled) await cancelled;
      await activity.done;
      expect(notices).toHaveLength(1);
      expect(mgr.get(activity.id)).toBe(activity);
      mgr.track(fakeActivity("after-release").activity, {
        callId: "after-release-call",
        emit: () => {},
      });
      expect(mgr.get(activity.id)).toBeUndefined();
    }
  });

  it("keeps notice suppression while another concurrent waiter remains", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new ActivityManager("c" as ConversationId);
      const { activity, settle } = fakeActivity("overlap");
      const notices: ContentBlock[][] = [];
      mgr.track(activity, { callId: "overlap-call", emit: () => {} });
      mgr.notifyOnExit(activity.id, (content) => notices.push(content));
      const short = mgr.wait(activity.id, 10);
      const long = mgr.wait(activity.id, 1000);
      await vi.advanceTimersByTimeAsync(10);
      expect(await short).toBe("running");
      settle({ status: "ok", summary: "completed", view: [] });
      expect(await long).toMatchObject({ status: "ok" });
      expect(notices).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases cancelled explicit waits without discarding background completion", async () => {
    for (const timing of ["before-exit", "at-exit"] as const) {
      const mgr = new ActivityManager("c" as ConversationId);
      const controller = new AbortController();
      const { activity, settle } = fakeActivity(timing);
      const notices: ContentBlock[][] = [];
      mgr.track(activity, {
        callId: timing,
        emit: (event) => {
          if (timing === "at-exit" && event.type === "activity.exited") controller.abort();
        },
      });
      mgr.notifyOnExit(activity.id, (content) => notices.push(content));
      const waiting = new ActivityWaitTool().execute(
        { id: activity.id },
        fakeCtx({
          signal: controller.signal,
          service: (key) => (key === "activities" ? mgr : undefined),
        }),
      );
      const rejected = expect(waiting).rejects.toThrow(/abort/i);
      if (timing === "before-exit") {
        controller.abort();
        await rejected;
      }
      settle({ status: "ok", summary: "completed", view: [] });
      await rejected;
      await activity.done;
      expect(notices).toHaveLength(1);
      mgr.notifyOnExit(activity.id, (content) => notices.push(content));
      expect(notices).toHaveLength(1);
    }
  });

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

  it("runningCount counts only unsettled activities", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const { activity: a, settle } = fakeActivity("r1");
    const { activity: b } = fakeActivity("r2");
    mgr.track(a, { callId: "k1", emit: () => {} });
    mgr.track(b, { callId: "k2", emit: () => {} });
    expect(mgr.runningCount()).toBe(2);
    settle({ status: "ok", summary: "done", view: [] });
    await tick();
    expect(mgr.runningCount()).toBe(1);
  });

  it("rejects duplicate activity and active call ids instead of overwriting ownership", () => {
    const mgr = new ActivityManager("c" as ConversationId);
    mgr.track(fakeActivity("a1").activity, { callId: "call-1", emit: () => {} });

    expect(() =>
      mgr.track(fakeActivity("a1").activity, { callId: "call-2", emit: () => {} }),
    ).toThrow("already tracked");
    expect(() =>
      mgr.track(fakeActivity("a2").activity, { callId: "call-1", emit: () => {} }),
    ).toThrow("already tracked");
  });

  it("never kills settled activities directly", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    let settledKills = 0;
    const settled = fakeActivity("done");
    settled.activity.kill = () => settledKills++;
    mgr.track(settled.activity, { callId: "done-call", emit: () => {} });
    settled.settle({ status: "ok", summary: "done", view: [] });
    await tick();

    expect(mgr.kill("done")).toBe("settled");
    expect(mgr.kill("missing")).toBe("unknown");
    expect(settledKills).toBe(0);
  });

  it("disposes live activities, waits for settlement, and suppresses completion delivery", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const live = fakeActivity("live");
    let kills = 0;
    live.activity.kill = () => {
      kills++;
      live.settle({ status: "error", summary: "killed", view: [] });
    };
    const notices: ContentBlock[][] = [];
    mgr.track(live.activity, { callId: "live-call", emit: () => {} });
    mgr.notifyOnExit(live.activity.id, (content) => notices.push(content));

    await mgr.dispose();
    await tick();

    expect(kills).toBe(1);
    expect(notices).toEqual([]);
    await expect(mgr.dispose()).resolves.toBeUndefined();
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

describe("backgroundContractResolver", () => {
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
    const resolver = backgroundContractResolver();
    const seen = {
      ...request,
      tools: await Promise.all(
        request.tools!.map(async (input) => (await resolver({ input }, ctx))!.input),
      ),
    };

    const find = (name: string): Record<string, unknown> => {
      const tool = seen.tools.find((t) => t.name === name)!;
      return (tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters
        .properties;
    };
    expect(find("bash").background).toBeDefined();
    expect(find("bash").command).toBeDefined(); // original args preserved
    expect(find("read").background).toBeUndefined();
  });
});
