import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKernelEvent,
  textOf,
  type HarnessEvent,
  type ModelMiddleware,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type Tool,
  type ToolResult,
} from "@harness/protocol";
import { approvalPlugin, approvalAnnotationOf, isApprovalDecidedEvent } from "@harness/approval";
import { HarnessService } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { LocalExecutionContext } from "@harness/execution";
import {
  unusedCodeEvaluator,
  EchoTool,
  FakeProvider,
  GateTool,
  interleavedStep,
  textStep,
  toolStep,
} from "@harness/testkit";
import { autoApprovalPlugin, isAutoApprovalEvent } from "./auto-approval.ts";

class ThrowingEchoTool extends EchoTool {
  override execute(): Promise<ToolResult> {
    return Promise.reject(new Error("boom"));
  }
}

class FailingEchoTool extends EchoTool {
  override execute(): Promise<ToolResult> {
    return Promise.resolve({
      forModel: [{ type: "text", text: "returned failure" }],
      status: "error",
    });
  }
}

class AnnotatedEchoTool extends EchoTool {
  override execute(): Promise<ToolResult> {
    return Promise.resolve({
      forModel: [{ type: "text", text: "annotated" }],
      status: "ok",
      annotations: {
        trace: { source: "tool" },
        approval: {
          decision: "deny",
          responder: "policy",
          relationship: "out-of-workspace",
        },
      },
    });
  }
}

const makeService = (
  review: string | string[],
  options: {
    tool?: Tool;
    blockReview?: boolean;
    omitReviewCompletion?: boolean;
    modelMiddleware?: ModelMiddleware;
  } = {},
) => {
  const tool = options.tool ?? new EchoTool();
  const modelMiddleware = options.modelMiddleware;
  const store = new InMemoryStore();
  const inner = new FakeProvider([
    toolStep("call-1", tool.name, { value: "hello" }),
    textStep("finished"),
  ]);
  const requests: ModelRequest[] = [];
  let markReviewStarted!: () => void;
  const reviewStarted = new Promise<void>((resolve) => {
    markReviewStarted = resolve;
  });
  const provider: ModelProvider = {
    provider: "fake",
    capabilities: () => inner.capabilities(),
    validateConfig: () => inner.validateConfig(),
    listModels: () => inner.listModels(),
    async *stream(request, signal): AsyncIterable<ModelStreamEvent> {
      requests.push(request);
      if (options.blockReview && requests.length === 2) {
        markReviewStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      if (requests.length === 2) {
        for (const text of Array.isArray(review) ? review : [review]) {
          yield { type: "text_delta", text };
        }
        if (!options.omitReviewCompletion) {
          yield {
            type: "message",
            content: [{ type: "text", text: Array.isArray(review) ? review.join("") : review }],
          };
          yield {
            type: "completed",
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
          };
        }
        return;
      }
      yield* inner.stream();
    },
  };
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
    home: "/nonexistent-auto-approval-home",
    plugins: [
      {
        id: "fake",
        providers: () => [provider],
        tools: () => [tool],
        ...(modelMiddleware ? { modelMiddleware: () => [modelMiddleware] } : {}),
      },
      approvalPlugin,
      autoApprovalPlugin,
    ],
  });
  const events: HarnessEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, store, events, requests, reviewStarted };
};

const createEnabledConversation = (service: HarnessService) =>
  service.createConversation({
    overrides: {
      model: { provider: "fake", model: "main" },
      plugins: { "auto-approval": { enabled: true } },
    },
  });

const makeFileReviewService = (
  workspaceRoot: string,
  review: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelStreamEvent>,
) => {
  const store = new InMemoryStore();
  const builds = vi.spyOn(store, "recordContextBuild");
  const payloads = vi.spyOn(store, "putProviderPayload");
  const tool = new EchoTool();
  const executed = vi.spyOn(tool, "execute");
  const inner = new FakeProvider([
    toolStep("call-1", tool.name, { value: "hello" }),
    textStep("finished"),
  ]);
  const reviewRequests: ModelRequest[] = [];
  const provider: ModelProvider = {
    provider: "fake",
    capabilities: () => inner.capabilities(),
    validateConfig: () => inner.validateConfig(),
    listModels: () => inner.listModels(),
    async *stream(request, signal) {
      if (request.tools?.some((schema) => schema.name === "read_file")) {
        reviewRequests.push(structuredClone(request));
        yield* review(request, signal);
      } else {
        yield* inner.stream();
      }
    },
  };
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
    home: "/nonexistent-auto-approval-home",
    plugins: [
      { id: "fake", providers: () => [provider], tools: () => [tool] },
      {
        id: "local-review-execution",
        services: () => [{ key: "execution", for: () => new LocalExecutionContext(workspaceRoot) }],
      },
      approvalPlugin,
      autoApprovalPlugin,
    ],
  });
  return { service, store, builds, payloads, executed, reviewRequests };
};

describe("auto approval integration", () => {
  it("uses the normal read tool's line offset and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-lines-"));
    await writeFile(join(root, "lines.txt"), "first\nsecond α\nthird\nlast");
    const fixture = makeFileReviewService(root, async function* (request) {
      const inspected = request.items.find(
        ({ item }) => item.type === "tool_result" && item.callId === "inspect-lines",
      );
      if (!inspected) {
        yield* toolStep("inspect-lines", "read_file", { path: "lines.txt", offset: 1, limit: 1 });
      } else {
        const content = inspected.item.type === "tool_result" ? textOf(inspected.item.content) : "";
        expect(content).toContain("[lines 2-2 of 4]\nsecond α");
        expect(content).not.toContain("first");
        expect(content).not.toContain("third");
        yield* textStep("YES");
      }
    });
    try {
      const conversation = await fixture.service.createConversation({
        cwd: root,
        overrides: {
          model: { provider: "fake", model: "main" },
          plugins: { "auto-approval": { enabled: true } },
        },
      });
      await fixture.service.send(conversation.id, "perform the requested project work");
      await fixture.service.whenIdle(conversation.id);
      expect(fixture.executed).toHaveBeenCalledOnce();
      expect(fixture.reviewRequests).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { script: "echo project-test", decision: "allow" },
    { script: "rm -rf /unrelated-home", decision: "deny" },
  ])(
    "lets inspected file contents change the final $decision verdict",
    async ({ script, decision }) => {
      const root = await mkdtemp(join(tmpdir(), "auto-review-script-"));
      await writeFile(join(root, "script.sh"), script);
      const fixture = makeFileReviewService(root, async function* (request) {
        const inspected = request.items.find(
          ({ item }) => item.type === "tool_result" && item.callId === "inspect-script",
        );
        if (!inspected) {
          yield* toolStep("inspect-script", "read_file", { path: "script.sh" });
        } else {
          const content =
            inspected.item.type === "tool_result" ? textOf(inspected.item.content) : "";
          yield* textStep(
            content.includes("/unrelated-home")
              ? "NO\nThe inspected script deletes an unrelated directory."
              : "YES",
          );
        }
      });
      try {
        const conversation = await fixture.service.createConversation({
          cwd: root,
          overrides: {
            model: { provider: "fake", model: "main" },
            plugins: { "auto-approval": { enabled: true } },
          },
        });
        await fixture.service.send(conversation.id, "perform the requested project work");
        await fixture.service.whenIdle(conversation.id);
        const result = (await fixture.store.listOwnedItems(conversation.id)).find(
          (item) => item.type === "tool_result",
        );
        expect(
          result?.type === "tool_result" && approvalAnnotationOf(result.annotations),
        ).toMatchObject({ decision, responder: "auto" });
        expect(fixture.executed).toHaveBeenCalledTimes(decision === "allow" ? 1 : 0);
        expect(fixture.reviewRequests).toHaveLength(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("continues YES plus file reads, retains native payloads only in memory, and accounts every review step", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-inspection-"));
    const secret = "inspection-only-file-marker";
    const native = {
      provider: "fake",
      model: "main",
      type: "review-reasoning",
      version: 1,
      payload: { opaque: "inspection-only-native-marker" },
    };
    await writeFile(join(root, "generated.ts"), secret);
    let reviewStep = 0;
    const fixture = makeFileReviewService(root, async function* (request) {
      expect(fixture.executed).not.toHaveBeenCalled();
      if (reviewStep > 0) {
        const results = request.items.filter(
          ({ item }) => item.type === "tool_result" && item.callId.startsWith("inspection-"),
        );
        expect(results).toHaveLength(reviewStep);
        const latest = results.at(-1)!.item;
        expect(latest.type === "tool_result" && textOf(latest.content)).toContain(secret);
        expect(
          request.items.some(
            ({ payload }) =>
              payload?.payload &&
              JSON.stringify(payload.payload).includes("inspection-only-native-marker"),
          ),
        ).toBe(true);
      }
      if (reviewStep++ < 20) {
        yield* interleavedStep([
          { reasoning: "inspection-only-reasoning-marker", payload: native },
          "YES",
          {
            callId: `inspection-${reviewStep}`,
            name: "read_file",
            args: { path: "generated.ts", offset: 0, limit: 128 },
          },
        ]);
      } else {
        yield* textStep("YES");
      }
    });
    try {
      const conversation = await fixture.service.createConversation({
        cwd: root,
        overrides: {
          model: { provider: "fake", model: "main" },
          plugins: { "auto-approval": { enabled: true } },
        },
      });
      await fixture.service.send(conversation.id, "inspect then run the requested tool");
      await fixture.service.whenIdle(conversation.id);
      expect(fixture.executed).toHaveBeenCalledOnce();
      expect(fixture.reviewRequests).toHaveLength(21);
      const items = await fixture.store.listOwnedItems(conversation.id);
      const result = items.find((item) => item.type === "tool_result");
      expect(
        result?.type === "tool_result" && approvalAnnotationOf(result.annotations),
      ).toMatchObject({ decision: "allow", responder: "auto" });
      expect(JSON.stringify(items)).not.toContain("inspection-only-");
      expect(await fixture.service.listConversations()).toHaveLength(1);
      expect(fixture.payloads).not.toHaveBeenCalled();
      expect(fixture.builds).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(fixture.builds.mock.calls)).not.toContain("inspection-only-");
      const usage = await fixture.service.usage(conversation.id);
      const reviews = usage.filter((row) => row.purpose === "auto-approval");
      expect(reviews).toHaveLength(21);
      expect(
        reviews.every((row) => row.contextBuildId === null && row.turnId === usage[0]!.turnId),
      ).toBe(true);
      const main = usage.filter((row) => row.purpose === "agent");
      expect(main).toHaveLength(2);
      for (const row of main) {
        expect(row.contextBuildId).not.toBeNull();
        expect(await fixture.store.getContextBuild(row.contextBuildId!)).toBeDefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an inspected review continuation without executing the pending tool or storing a verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-cancel-"));
    await writeFile(join(root, "generated.ts"), "inspection-only-cancel-marker");
    let continuationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      continuationStarted = resolve;
    });
    let step = 0;
    const fixture = makeFileReviewService(root, async function* (_request, signal) {
      if (step++ === 0) {
        yield* toolStep("inspection-cancel", "read_file", { path: "generated.ts" });
        return;
      }
      continuationStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    try {
      const conversation = await fixture.service.createConversation({
        cwd: root,
        overrides: {
          model: { provider: "fake", model: "main" },
          plugins: { "auto-approval": { enabled: true } },
        },
      });
      await fixture.service.send(conversation.id, "go");
      await started;
      await fixture.service.deliver(conversation.id, "", "interrupt");
      await fixture.service.whenIdle(conversation.id);
      expect(fixture.executed).not.toHaveBeenCalled();
      const items = await fixture.store.listOwnedItems(conversation.id);
      const result = items.find((item) => item.type === "tool_result");
      expect(result?.type === "tool_result" && result.status).toBe("error");
      expect(result?.type === "tool_result" && result.annotations).toBeUndefined();
      expect(JSON.stringify(items)).not.toContain("inspection-only-cancel-marker");
      expect(fixture.builds).toHaveBeenCalledOnce();
      expect(
        (await fixture.service.usage(conversation.id)).filter(
          (row) => row.purpose === "auto-approval",
        ),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out an inspected continuation within the single review deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-timeout-"));
    await writeFile(join(root, "generated.ts"), "inspection-only-timeout-marker");
    let step = 0;
    const fixture = makeFileReviewService(root, async function* (_request, signal) {
      if (step++ === 0) {
        yield* toolStep("inspection-timeout", "read_file", { path: "generated.ts" });
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    try {
      const conversation = await fixture.service.createConversation({
        cwd: root,
        overrides: {
          model: { provider: "fake", model: "main" },
          plugins: { "auto-approval": { enabled: true, timeoutSeconds: 0.2 } },
        },
      });
      await fixture.service.send(conversation.id, "go");
      await fixture.service.whenIdle(conversation.id);
      expect(fixture.executed).not.toHaveBeenCalled();
      const result = (await fixture.store.listOwnedItems(conversation.id)).find(
        (item) => item.type === "tool_result",
      );
      const approval =
        result?.type === "tool_result" ? approvalAnnotationOf(result.annotations) : undefined;
      expect(approval).toMatchObject({ decision: "deny", responder: "auto" });
      expect(approval?.reason).toContain("timed out");
      expect(fixture.reviewRequests).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes the reviewer invocation through model middleware", async () => {
    const observed: { hasTools: boolean; missingMeta: unknown }[] = [];
    const middleware: ModelMiddleware = {
      id: "record-all-model-calls",
      wrap(request, ctx, next) {
        observed.push({
          hasTools: request.tools !== undefined,
          missingMeta: ctx.toolMeta("missing"),
        });
        return next(request);
      },
    };
    const { service } = makeService("YES", { modelMiddleware: middleware });
    const conversation = await createEnabledConversation(service);

    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    expect(observed).toHaveLength(3);
    expect(observed[1]).toEqual({ hasTools: true, missingMeta: undefined });
  });

  it("auto-approves an asked tool, executes it, and durably annotates the result", async () => {
    const { service, events } = makeService(["Y", "ES"]);
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    expect(events.some((event) => isKernelEvent(event) && event.type === "request.created")).toBe(
      false,
    );
    const completed = events.find(
      (event) =>
        isKernelEvent(event) && event.type === "item.appended" && event.item.type === "tool_result",
    );
    if (
      !completed ||
      !isKernelEvent(completed) ||
      completed.type !== "item.appended" ||
      completed.item.type !== "tool_result"
    )
      throw new Error("missing tool result event");
    expect(completed.item.status).toBe("ok");
    expect(approvalAnnotationOf(completed.item.annotations)).toMatchObject({
      decision: "allow",
      responder: "auto",
      relationship: "unknown",
    });
    expect(events.filter(isAutoApprovalEvent).map((event) => event.type)).toEqual([
      "auto-approval.reviewing",
    ]);
    expect(events.filter(isApprovalDecidedEvent)).toMatchObject([
      { type: "approval.decided", decision: "allow", responder: "auto" },
    ]);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "allow", responder: "auto" });
    expect(await service.usage(conversation.id)).toHaveLength(3);
  });

  it("fails closed when the reviewer stream ends without completed", async () => {
    const { service } = makeService("YES", { omitReviewCompletion: true });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    const approval =
      durable?.type === "tool_result" ? approvalAnnotationOf(durable.annotations) : undefined;
    expect(approval).toMatchObject({
      decision: "deny",
      responder: "auto",
    });
    expect(approval?.reason).toContain("without a 'completed' event");
  });

  it("keeps an approval annotation when the approved tool throws", async () => {
    const { service } = makeService("YES", { tool: new ThrowingEchoTool() });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "allow", responder: "auto" });
  });

  it("keeps an approval annotation when the approved tool returns an error", async () => {
    const { service } = makeService("YES", { tool: new FailingEchoTool() });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "allow", responder: "auto" });
  });

  it("preserves unrelated annotations and gives scoped approval metadata precedence", async () => {
    const { service } = makeService("YES", { tool: new AnnotatedEchoTool() });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.annotations?.["trace"]).toEqual({
      source: "tool",
    });
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "allow", responder: "auto" });
  });

  it("keeps an approval annotation when a running approved tool is interrupted", async () => {
    const gate = new GateTool({ name: "echo" });
    const { service } = makeService("YES", { tool: gate });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await gate.started;
    await service.deliver(conversation.id, "", "interrupt");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "allow", responder: "auto" });
    gate.release();
  });

  it("interrupts an in-flight review without inventing a decision annotation", async () => {
    const { service, events, reviewStarted } = makeService("YES", { blockReview: true });
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await reviewStarted;
    await service.deliver(conversation.id, "", "interrupt");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    expect(durable?.type === "tool_result" && durable.annotations).toBeUndefined();
    expect(events.filter(isAutoApprovalEvent).map((event) => event.type)).toEqual([
      "auto-approval.reviewing",
    ]);
  });

  it("feeds the automatic denial reason back as a durable tool error", async () => {
    const { service, requests } = makeService("NO\nThe user did not authorize this.");
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    expect(durable?.type === "tool_result" && textOf(durable.content)).toContain(
      "The user did not authorize this.",
    );
    expect(
      durable?.type === "tool_result" && approvalAnnotationOf(durable.annotations),
    ).toMatchObject({ decision: "deny", responder: "auto" });
    const finalRequest = requests[2];
    expect(
      finalRequest?.items.some(
        ({ item }) =>
          item.type === "tool_result" && textOf(item.content).includes("did not authorize"),
      ),
    ).toBe(true);
  });

  it("denies an approval response containing text in addition to YES", async () => {
    const { service } = makeService("YES\nThis call is safe.");
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    const durable = (await service.getItems(conversation.id)).find(
      (item) => item.type === "tool_result",
    );
    expect(durable?.type === "tool_result" && durable.status).toBe("error");
    const approval =
      durable?.type === "tool_result" ? approvalAnnotationOf(durable.annotations) : undefined;
    expect(approval).toMatchObject({
      decision: "deny",
      responder: "auto",
      relationship: "unknown",
    });
    expect(approval?.reason).toContain("not exactly YES");
  });

  it("saves enabled in both scopes without copying the global reviewer into overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "auto-approval-config-"));
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        version: 1,
        model: { provider: "fake", model: "main" },
        plugins: {
          "auto-approval": {
            enabled: false,
            model: { provider: "fake", model: "reviewer" },
          },
        },
      }),
    );
    const store = new InMemoryStore();
    const service = new HarnessService({
      codeEvaluator: unusedCodeEvaluator,
      store,
      home,
      plugins: [
        { id: "fake", providers: () => [new FakeProvider([])] },
        approvalPlugin,
        autoApprovalPlugin,
      ],
    });
    const conversation = await service.createConversation();
    await service.setPluginConfig(
      conversation.id,
      "auto-approval",
      { enabled: true },
      { saveGlobal: true },
    );

    const record = await store.getConversation(conversation.id);
    expect(record?.overrides).toMatchObject({
      plugins: { "auto-approval": { enabled: true } },
    });
    expect(
      (record?.overrides.plugins as Record<string, unknown>)?.["auto-approval"],
    ).not.toHaveProperty("model");
    const global = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as {
      plugins: Record<string, unknown>;
    };
    expect(global.plugins["auto-approval"]).toEqual({
      enabled: true,
      model: { provider: "fake", model: "reviewer" },
    });
    expect(
      (await service.getConversation(conversation.id))?.config.plugins?.["auto-approval"],
    ).toEqual({
      enabled: true,
      model: { provider: "fake", model: "reviewer" },
      timeoutSeconds: 30,
    });
  });
});
