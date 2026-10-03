import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentBlock,
  ConversationId,
  ToolMiddlewareContext,
  ToolResult,
} from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { outputBoundMiddleware } from "./output.ts";

const created: string[] = [];
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hout-"));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const text = (blocks: ContentBlock[]): string =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");

function ctxWith(
  over: Partial<ToolMiddlewareContext> = {},
  execution?: LocalExecutionContext,
): ToolMiddlewareContext {
  return {
    conversationId: "conv" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    service: (key) => (key === "execution" ? execution : undefined),
    toolMeta: () => undefined,
    toolContract: () => undefined,
    acceptsToolCall: () => true,
    setResultAnnotation: () => {},
    emit: () => {},
    deliver: () => {},
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => Promise.resolve({}),
    active: () => Promise.resolve([]),
    appendContext: () => Promise.resolve(),
    ...over,
  };
}

const oversized = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
const passthrough = (result: ToolResult) => () => Promise.resolve(result);

describe("outputBoundMiddleware", () => {
  it("spills oversized output to a file and shows a head view + pointer", async () => {
    const ctx = ctxWith({}, new LocalExecutionContext(await tmpRoot()));
    const result = await outputBoundMiddleware().wrap(
      { callId: "g", name: "command", args: {} },
      ctx,
      passthrough({ forModel: [{ type: "text", text: oversized }], status: "ok" }),
    );
    const out = text(result.forModel);
    expect(out).toContain("output truncated");
    expect(out).toContain(".harness/conv/outputs/out_");
    expect(out).toContain("line 0"); // head shown
    expect(out).not.toContain("line 999"); // tail elided from the inline view
  });

  it("skips addressableOutput tools", async () => {
    const ctx = ctxWith(
      { toolMeta: () => ({ addressableOutput: true }) },
      new LocalExecutionContext(await tmpRoot()),
    );
    const result: ToolResult = {
      forModel: [{ type: "text", text: "z".repeat(20_000) }],
      status: "ok",
    };
    expect(
      await outputBoundMiddleware().wrap(
        { callId: "r", name: "read_file", args: {} },
        ctx,
        passthrough(result),
      ),
    ).toBe(result);
  });

  it("leaves small output and execution-less calls untouched", async () => {
    const small: ToolResult = { forModel: [{ type: "text", text: "small" }], status: "ok" };
    const withExec = ctxWith({}, new LocalExecutionContext(await tmpRoot()));
    expect(
      await outputBoundMiddleware().wrap(
        { callId: "x", name: "command", args: {} },
        withExec,
        passthrough(small),
      ),
    ).toBe(small);

    const big: ToolResult = { forModel: [{ type: "text", text: oversized }], status: "ok" };
    const noExec = ctxWith(); // execution undefined ⇒ defer to the core truncate floor
    expect(
      await outputBoundMiddleware().wrap(
        { callId: "x", name: "command", args: {} },
        noExec,
        passthrough(big),
      ),
    ).toBe(big);
  });
});
