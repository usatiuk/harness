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
  ActivityPeekTool,
  ActivityKillTool,
  ActivityListTool,
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
  it("releases wait protection when a synchronous result consumer throws", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const target = fakeActivity("target");
    mgr.track(target.activity, { callId: "target-call", emit: () => {} });
    target.settle({ status: "ok", summary: "completed", view: [] });
    await expect(
      mgr.wait(target.activity.id, 1000, () => {
        expect(mgr.get(target.activity.id)).toBe(target.activity);
        throw new Error("consumer defect");
      }),
    ).rejects.toThrow("consumer defect");
    for (let i = 0; i < 50; i++)
      mgr.track(fakeActivity(`live-${i}`).activity, { callId: `live-${i}`, emit: () => {} });
    expect(mgr.get(target.activity.id)).toBeUndefined();
  });

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
        ? expect(
            mgr.wait(activity.id, 1000, (outcome) => outcome, controller.signal),
          ).rejects.toThrow(/abort/i)
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
      const short = mgr.wait(activity.id, 10, (outcome) => outcome);
      const long = mgr.wait(activity.id, 1000, (outcome) => outcome);
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
    const waiting = mgr.wait("a1", 1000, (outcome) => outcome); // registers #waiting synchronously
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

  it("strips background but preserves sibling args like max_lines", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const ctx = fakeMwCtx({ service: (k) => (k === "activities" ? mgr : undefined) });
    const next = (call: { callId: string; args: unknown }): Promise<ToolResult> => {
      // background is consumed by the middleware; max_lines still reaches the tool's schema.
      expect(call.args).toEqual({ command: "x", max_lines: 200 });
      const { activity, settle } = fakeActivity("a6");
      settle({ status: "ok", summary: "s", view: [{ type: "text", text: "yo" }] });
      mgr.track(activity, { callId: call.callId, emit: () => {} });
      return Promise.resolve({ forModel: [{ type: "text", text: "placeholder" }], status: "ok" });
    };
    const result = await consumeMiddleware().wrap(
      { callId: "k2", name: "bash", args: { command: "x", max_lines: 200, background: true } },
      ctx,
      next,
    );
    expect(text(result.forModel)).toContain("background");
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
      reportRetry: () => {},
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

describe("owner-local readable activity references", () => {
  it.each(["wait", "foreground"] as const)(
    "formats a %s timeout safely when completion and collection follow the deadline",
    async (path) => {
      vi.useFakeTimers();
      try {
        const mgr = new ActivityManager("c" as ConversationId);
        const notices: ContentBlock[][] = [];
        const ctx = fakeCtx({ service: () => mgr, deliver: (content) => notices.push(content) });
        const target = fakeActivity("target-id");
        mgr.track(target.activity, { callId: "target-call", emit: () => {} });
        for (let i = 0; i < 49; i++) {
          const history = fakeActivity(`history-${i}`);
          mgr.track(history.activity, { callId: history.activity.id, emit: () => {} });
          history.settle({ status: "ok", summary: "old result", view: [] });
        }
        await Promise.resolve();
        const result =
          path === "wait"
            ? new ActivityWaitTool().execute({ id: "target-id", timeout_seconds: 1 }, ctx)
            : consume(mgr, target.activity, false, ctx);
        vi.advanceTimersByTime(path === "wait" ? 1000 : 10_000);
        const collect = Promise.resolve()
          .then(() =>
            target.settle({
              status: "ok",
              summary: "actual success",
              view: [{ type: "text", text: "actual output" }],
            }),
          )
          .then(() =>
            mgr.track(fakeActivity("replacement").activity, {
              callId: "replacement-call",
              emit: () => {},
            }),
          );
        const [timedOut] = await Promise.all([result, collect]);
        expect(timedOut.status).toBe("ok");
        expect(text(timedOut.forModel)).toContain("still running");
        expect(mgr.get(target.activity.id)).toBeUndefined();
        expect(notices).toEqual(
          path === "foreground"
            ? [
                [
                  { type: "text", text: "[activity target-id] actual success" },
                  { type: "text", text: "actual output" },
                ],
              ]
            : [],
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["wait", "foreground"] as const)(
    "preserves a completed %s result when its handle is collected before delivery",
    async (path) => {
      const mgr = new ActivityManager("c" as ConversationId);
      const ctx = fakeCtx({ service: () => mgr });
      const target = fakeActivity("target-id");
      const activity = { ...target.activity, title: "Review changes", reference: "review" };
      mgr.track(activity, { callId: "target-call", emit: () => {} });
      const histories = Array.from({ length: 49 }, (_, i) => fakeActivity(`history-${i}`));
      for (const history of histories) {
        mgr.track(history.activity, { callId: history.activity.id, emit: () => {} });
        history.settle({ status: "ok", summary: "old result", view: [] });
      }
      await Promise.all(histories.map(({ activity }) => activity.done));
      const result =
        path === "wait"
          ? new ActivityWaitTool().execute({ id: "review" }, ctx)
          : consume(mgr, activity, false, ctx);
      target.settle({
        status: "ok",
        summary: "completed successfully",
        view: [{ type: "text", text: "actual output" }],
      });
      const collect = async (): Promise<void> => {
        // Run after wait releases protection, but before the tool's result reaches its caller.
        await Promise.resolve();
        await Promise.resolve();
        mgr.track(fakeActivity("replacement").activity, {
          callId: "replacement-call",
          emit: () => {},
        });
        expect(mgr.get(activity.id)).toBeUndefined();
      };
      const [completed] = await Promise.all([result, collect()]);
      expect(completed.status).toBe("ok");
      expect(text(completed.forModel)).toBe(
        "[activity review] Review changes completed successfully\nactual output",
      );
      if (path === "foreground")
        expect(completed.structured).toEqual({
          activityId: "target-id",
          activityRef: "review",
          state: "completed",
          status: "ok",
          content: completed.forModel,
        });
    },
  );

  it.each(["wait", "foreground"] as const)(
    "uses canonical identity when a %s activity's readable labels become ambiguous while waiting",
    async (path) => {
      const mgr = new ActivityManager("c" as ConversationId);
      const ctx = fakeCtx({ service: () => mgr });
      const target = fakeActivity("target-id");
      const activity = { ...target.activity, title: "Review changes", reference: "review" };
      mgr.track(activity, { callId: "target-call", emit: () => {} });
      const result =
        path === "wait"
          ? new ActivityWaitTool().execute({ id: "review" }, ctx)
          : consume(mgr, activity, false, ctx);
      mgr.track(
        { ...fakeActivity("other-id").activity, title: activity.title, reference: "review" },
        { callId: "other-call", emit: () => {} },
      );
      target.settle({ status: "ok", summary: "completed", view: [] });
      expect(text((await result).forModel)).toBe("[activity target-id] Review changes completed");
    },
  );

  it("covers list/peek/wait/kill, labels foreground/background results and notices, and rejects cross-owner references", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const ctx = fakeCtx({ service: () => mgr });
    const { activity: base, settle } = fakeActivity("canonical-id");
    const kill = vi.fn();
    const activity = {
      ...base,
      reference: "review",
      title: "Review changes",
      kill,
      peek: () => [{ type: "text" as const, text: "progress" }],
    };
    mgr.track(activity, { callId: "spawn", emit: () => {} });
    const notices: ContentBlock[][] = [];
    const launched = await consume(mgr, activity, true, {
      ...ctx,
      deliver: (content) => notices.push(content),
    });
    expect(launched.structured).toMatchObject({
      activityId: "canonical-id",
      activityRef: "review",
      state: "running",
    });
    expect(text(launched.forModel)).toContain("Review changes [review]");
    expect(text(launched.forModel)).not.toContain("canonical-id");
    expect(text((await new ActivityListTool().execute({}, ctx)).forModel)).toContain(
      "Review changes [review]",
    );
    expect(text((await new ActivityPeekTool().execute({ id: "review" }, ctx)).forModel)).toBe(
      "progress",
    );
    expect((await new ActivityKillTool().execute({ id: "Review changes" }, ctx)).status).toBe("ok");
    expect(kill).toHaveBeenCalledOnce();
    const outsider = fakeCtx({ service: () => new ActivityManager("other" as ConversationId) });
    for (const id of ["review", "Review changes", "canonical-id"])
      expect((await new ActivityPeekTool().execute({ id }, outsider)).status).toBe("error");
    settle({ status: "ok", summary: "finished", view: [] });
    await activity.done;
    expect(text(notices[0]!)).toContain("[activity review] Review changes finished");
    expect(text((await new ActivityWaitTool().execute({ id: "review" }, ctx)).forModel)).toContain(
      "[activity review] Review changes",
    );
    expect((await new ActivityKillTool().execute({ id: "review" }, ctx)).status).toBe("error");
    const completed = await consume(mgr, activity, false, ctx);
    expect(completed.structured).toMatchObject({
      activityId: "canonical-id",
      activityRef: "review",
      state: "completed",
    });
  });

  it("rejects duplicate names and slug/name collisions; canonical IDs still win", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const ctx = fakeCtx({ service: () => mgr });
    const a = fakeActivity("a"),
      b = fakeActivity("b");
    mgr.track(
      { ...a.activity, title: "Same", reference: "review" },
      { callId: "a", emit: () => {} },
    );
    mgr.track(
      { ...b.activity, title: "Same", reference: "review" },
      { callId: "b", emit: () => {} },
    );
    expect(mgr.resolve("review")).toHaveProperty("error");
    expect(mgr.reference("a")).toBe("a");
    for (const tool of [new ActivityWaitTool(), new ActivityPeekTool(), new ActivityKillTool()])
      expect(text((await tool.execute({ id: "Same" }, ctx)).forModel)).toContain(
        "ambiguous activity",
      );
    expect(mgr.resolve("a")).toEqual({ id: "a" });
    expect(mgr.resolve("b")).toEqual({ id: "b" });
    const c = fakeActivity("c");
    mgr.track(
      { ...c.activity, title: "review", reference: "other" },
      { callId: "c", emit: () => {} },
    );
    expect(mgr.resolve("review")).toHaveProperty("error");
    // The same slug in a different owner resolves only within that manager.
    const other = new ActivityManager("other" as ConversationId);
    other.track(
      { ...fakeActivity("other-id").activity, reference: "review" },
      { callId: "other", emit: () => {} },
    );
    expect(other.resolve("review")).toEqual({ id: "other-id" });
    expect(mgr.resolve("other-id")).toHaveProperty("error");
    mgr.track(fakeActivity("review").activity, { callId: "canonical-review", emit: () => {} });
    expect(mgr.resolve("review")).toEqual({ id: "review" });
  });

  it("expires references at collection/restart without restoring them; legacy handles keep canonical fallback", async () => {
    const mgr = new ActivityManager("c" as ConversationId);
    const first = fakeActivity("old-id");
    mgr.track(
      { ...first.activity, title: "Old name", reference: "old-slug" },
      { callId: "old", emit: () => {} },
    );
    first.settle({ status: "ok", summary: "finished", view: [] });
    await first.activity.done;
    expect(mgr.resolve("old-slug")).toEqual({ id: "old-id" });
    for (let i = 0; i < 50; i++)
      mgr.track(fakeActivity(`live-${i}`).activity, { callId: `live-${i}`, emit: () => {} });
    for (const ref of ["old-slug", "Old name", "old-id"])
      expect(mgr.resolve(ref)).toHaveProperty("error");
    const restarted = new ActivityManager("c" as ConversationId);
    expect(restarted.resolve("live-1")).toHaveProperty("error");
    expect(mgr.resolve("live-1")).toEqual({ id: "live-1" });
  });
});
