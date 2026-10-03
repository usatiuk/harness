import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  okResult,
  type ConversationId,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@harness/protocol";
import type { ExecutionContext, OutputStore, Relationship, SpawnedProcess } from "./context.ts";
import {
  executionFunctionTool,
  splitCustomEscalation,
  splitStructuredExecutionArgs,
} from "./tool-control.ts";
import { executionOf } from "./context.ts";

function fakeExecution(label: string): ExecutionContext {
  return {
    workspaceRoot: "/work",
    shellKind: "bash",
    read: vi.fn(),
    stat: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    spawn: vi.fn(() => ({}) as SpawnedProcess),
    outputStore: vi.fn(() => ({}) as OutputStore),
    classify: vi.fn((): Relationship => "unknown"),
    label,
  } as ExecutionContext & { label: string };
}

function context(execution: ExecutionContext): ToolContext {
  return {
    conversationId: "c" as ConversationId,
    callId: "call",
    signal: new AbortController().signal,
    service: (key) => (key === "execution" ? execution : undefined),
    emit: vi.fn(),
    deliver: vi.fn(),
  };
}

describe("executionFunctionTool", () => {
  it("preserves a class tool's exposure and output contract on an escaping backend", async () => {
    class DeferredTool implements Tool {
      readonly name = "deferred";
      readonly description = "Deferred execution";
      readonly input = { kind: "function" as const, schema: z.strictObject({}) };
      readonly exposure = { direct: false, code: true };
      readonly outputSchema = { type: "string" };
      async execute() {
        return { ...okResult(this.name), structured: this.name };
      }
    }
    const sandbox = { ...fakeExecution("native"), unconfined: fakeExecution("host") };
    const original = new DeferredTool();
    const wrapped = executionFunctionTool(sandbox, original);
    expect(wrapped.exposure).toEqual({ direct: false, code: true });
    expect(wrapped.outputSchema).toEqual({ type: "string" });
    expect(await wrapped.execute({}, context(sandbox))).toMatchObject({ structured: "deferred" });
  });

  it("registers an execution-managed tool without changing non-escalating backends", () => {
    const register = vi.fn();
    const execution = { ...fakeExecution("docker"), registerManagedTool: register };
    const tool = {} as Tool;
    Object.assign(tool, {
      name: "write",
      description: "write",
      input: { kind: "function", schema: z.strictObject({ path: z.string() }) },
      execute: vi.fn(),
    });
    expect(executionFunctionTool(execution, tool)).toBe(tool);
    expect(register).toHaveBeenCalledWith("write");
  });

  it("adds controls and selects the unconfined context only for an explicit request", async () => {
    const host = fakeExecution("host");
    const register = vi.fn();
    const sandbox = {
      ...fakeExecution("native"),
      unconfined: host,
      registerManagedTool: register,
    };
    const seen: string[] = [];
    const tool: Tool<{ value: string }> = {
      name: "write",
      description: "write",
      input: { kind: "function", schema: z.strictObject({ value: z.string() }) },
      execute(args, ctx): Promise<ToolResult> {
        seen.push(
          `${args.value}:${(executionOf(ctx) as ExecutionContext & { label: string }).label}`,
        );
        return Promise.resolve(okResult("ok"));
      },
    };
    const wrapped = executionFunctionTool(sandbox, tool);
    expect(wrapped.input.kind).toBe("function");
    if (wrapped.input.kind !== "function") throw new Error("expected function input");

    const normal = wrapped.input.schema.parse({ value: "a" });
    await wrapped.execute(normal, context(sandbox));
    const escaped = wrapped.input.schema.parse({
      value: "b",
      sandbox_permissions: "require_escalated",
      justification: "needs host access",
    });
    await wrapped.execute(escaped, context(sandbox));

    expect(seen).toEqual(["a:native", "b:host"]);
    expect(register).toHaveBeenCalledWith("write");
  });

  it("rejects missing or detached justifications before execution", () => {
    expect(
      splitStructuredExecutionArgs({
        path: "x",
        sandbox_permissions: "require_escalated",
      }).error,
    ).toMatchObject({ status: "error" });
    expect(splitStructuredExecutionArgs({ path: "x", justification: "why" }).error).toMatchObject({
      status: "error",
    });
  });
});

describe("custom execution header", () => {
  it("keeps ordinary input byte-for-byte and splits an explicit escalation header", () => {
    const patch = "*** Begin Patch\n*** End Patch";
    expect(splitCustomEscalation(patch)).toEqual({ input: patch });
    expect(
      splitCustomEscalation(
        "sandbox_permissions=require_escalated\njustification=outside write\n---\n" + patch,
      ),
    ).toEqual({
      input: patch,
      escalation: {
        sandboxPermissions: "require_escalated",
        justification: "outside write",
      },
    });
  });
});
