import { describe, expect, it } from "vitest";
import type {
  ConfigReader,
  ConversationId,
  ToolCall,
  ToolMiddleware,
  ToolMiddlewareContext,
  ToolResult,
} from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { approvalPlugin, isApprovalDecidedEvent } from "./approval.ts";

function middlewareFor(config: unknown): ToolMiddleware {
  const reader: ConfigReader = { get: <C>() => Promise.resolve(config as C) };
  return approvalPlugin.create(reader).toolMiddleware!()[0]!;
}

function contextFor(decision: "allow" | "deny" = "allow"): {
  ctx: ToolMiddlewareContext;
  asked: () => boolean;
  annotation: () => unknown;
} {
  let asked = false;
  const annotations: Record<string, unknown> = {};
  const execution = new LocalExecutionContext("/work");
  const ctx: ToolMiddlewareContext = {
    conversationId: "c" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    service: (key) => (key === "execution" ? execution : undefined),
    toolMeta: () => undefined,
    toolContract: () => undefined,
    acceptsToolCall: () => true,
    setResultAnnotation: (key, value) => {
      annotations[key] = value;
    },
    emit: () => {},
    deliver: () => {},
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => {
      asked = true;
      return Promise.resolve({ decision });
    },
    active: () => Promise.resolve([]),
    appendContext: () => Promise.resolve(),
  };
  return { ctx, asked: () => asked, annotation: () => annotations["approval"] };
}

const ran: ToolResult = { forModel: [{ type: "text", text: "ran" }], status: "ok" };
const next = (): Promise<ToolResult> => Promise.resolve(ran);
const call = (name: string, args: unknown): ToolCall => ({ callId: "1", name, args });

describe("approval policy", () => {
  it("auto-allows an in-workspace call without asking (default policy)", async () => {
    const { ctx, asked } = contextFor();
    const result = await middlewareFor({}).wrap(call("read_file", { path: "src/x.ts" }), ctx, next);
    expect(result).toBe(ran);
    expect(asked()).toBe(false);
  });

  it("asks for an out-of-workspace call; allows on approve, errors on deny", async () => {
    const approve = contextFor();
    const allowed = await middlewareFor({}).wrap(
      call("write", { path: "/etc/x" }),
      approve.ctx,
      next,
    );
    expect(allowed).toBe(ran);
    expect(approve.annotation()).toMatchObject({
      decision: "allow",
      responder: "human",
      relationship: "out-of-workspace",
    });
    expect(approve.asked()).toBe(true);

    const deny = contextFor("deny");
    const denied = await middlewareFor({}).wrap(call("write", { path: "/etc/x" }), deny.ctx, next);
    expect(denied.status).toBe("error");
    expect(deny.annotation()).toMatchObject({ decision: "deny", responder: "human" });
  });

  it("asks for an unknown-scope command using the out-of-workspace rule", async () => {
    const { ctx, asked, annotation } = contextFor();
    await middlewareFor({}).wrap(call("powershell", { command: "Get-ChildItem" }), ctx, next);
    expect(asked()).toBe(true);
    expect(annotation()).toMatchObject({ relationship: "unknown" });

    const allowed = contextFor();
    await middlewareFor({
      outOfWorkspace: "deny",
      tools: { powershell: { outOfWorkspace: "allow" } },
    }).wrap(call("powershell", { command: "Get-ChildItem" }), allowed.ctx, next);
    expect(allowed.asked()).toBe(false);
  });

  it("captures the annotation before emitting the decided event", async () => {
    const state = contextFor();
    state.ctx.request = () =>
      Promise.resolve({
        decision: "allow",
        responder: "auto",
        model: { provider: "fake", model: "reviewer" },
      });
    let annotationAtEmit: unknown;
    state.ctx.emit = (event) => {
      if (isApprovalDecidedEvent(event)) annotationAtEmit = state.annotation();
    };

    await middlewareFor({}).wrap(call("write", { path: "/etc/x" }), state.ctx, next);

    expect(annotationAtEmit).toMatchObject({
      decision: "allow",
      responder: "auto",
      model: { provider: "fake", model: "reviewer" },
    });
  });

  it("denies by rule without asking, and honours a per-tool allow override", async () => {
    const denied = await middlewareFor({ tools: { powershell: "deny" } }).wrap(
      call("powershell", { command: "Get-ChildItem" }),
      contextFor().ctx,
      next,
    );
    expect(denied.status).toBe("error");

    const allow = contextFor();
    const allowed = await middlewareFor({ tools: { powershell: "allow" } }).wrap(
      call("powershell", { command: "Get-ChildItem" }),
      allow.ctx,
      next,
    );
    expect(allowed).toBe(ran);
    expect(allow.asked()).toBe(false);
  });
});
