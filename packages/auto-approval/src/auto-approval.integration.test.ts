import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKernelEvent,
  textOf,
  type HarnessEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type Tool,
  type ToolResult,
} from "@harness/protocol";
import { approvalPlugin, approvalAnnotationOf, isApprovalDecidedEvent } from "@harness/approval";
import { HarnessService } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { EchoTool, FakeProvider, GateTool, textStep, toolStep } from "@harness/testkit";
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
  options: { tool?: Tool; blockReview?: boolean; omitReviewCompletion?: boolean } = {},
) => {
  const tool = options.tool ?? new EchoTool();
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
    store,
    home: "/nonexistent-auto-approval-home",
    plugins: [
      {
        id: "fake",
        providers: () => [provider],
        tools: () => [tool],
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

describe("auto approval integration", () => {
  it("auto-approves an asked tool, executes it, and durably annotates the result", async () => {
    const { service, events } = makeService(["Y", "ES"]);
    const conversation = await createEnabledConversation(service);
    await service.send(conversation.id, "go");
    await service.whenIdle(conversation.id);

    expect(events.some((event) => isKernelEvent(event) && event.type === "request.created")).toBe(
      false,
    );
    const completed = events.find(
      (event) => isKernelEvent(event) && event.type === "tool_call.completed",
    );
    expect(completed && "annotations" in completed).toBeTruthy();
    if (!completed || !isKernelEvent(completed) || completed.type !== "tool_call.completed") return;
    expect(completed.status).toBe("ok");
    expect(approvalAnnotationOf(completed.annotations)).toMatchObject({
      decision: "allow",
      responder: "auto",
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

  it("saves enabled in both scopes without copying the global reviewer into overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "auto-approval-config-"));
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
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
    });
  });
});
