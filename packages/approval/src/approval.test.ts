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
import { approvalPlugin } from "./approval.ts";

function middlewareFor(config: unknown): ToolMiddleware {
  const reader: ConfigReader = { get: <C>() => Promise.resolve(config as C) };
  return approvalPlugin.create(reader).toolMiddleware!()[0]!;
}

function contextFor(decision?: string): { ctx: ToolMiddlewareContext; asked: () => boolean } {
  let asked = false;
  const execution = new LocalExecutionContext("/work");
  const ctx: ToolMiddlewareContext = {
    conversationId: "c" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    service: (key) => (key === "execution" ? execution : undefined),
    toolMeta: () => undefined,
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
  return { ctx, asked: () => asked };
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
    const approve = contextFor(); // no/undefined decision ⇒ allow
    const allowed = await middlewareFor({}).wrap(
      call("write", { path: "/etc/x" }),
      approve.ctx,
      next,
    );
    expect(allowed).toBe(ran);
    expect(approve.asked()).toBe(true);

    const deny = contextFor("deny");
    const denied = await middlewareFor({}).wrap(call("write", { path: "/etc/x" }), deny.ctx, next);
    expect(denied.status).toBe("error");
  });

  it("asks for bash by default (no in-workspace path ⇒ out-of-workspace)", async () => {
    const { ctx, asked } = contextFor();
    await middlewareFor({}).wrap(call("bash", { command: "ls" }), ctx, next);
    expect(asked()).toBe(true);
  });

  it("denies by rule without asking, and honours a per-tool allow override", async () => {
    const denied = await middlewareFor({ tools: { bash: "deny" } }).wrap(
      call("bash", { command: "ls" }),
      contextFor().ctx,
      next,
    );
    expect(denied.status).toBe("error");

    const allow = contextFor();
    const allowed = await middlewareFor({ tools: { bash: "allow" } }).wrap(
      call("bash", { command: "ls" }),
      allow.ctx,
      next,
    );
    expect(allowed).toBe(ran);
    expect(allow.asked()).toBe(false);
  });
});
