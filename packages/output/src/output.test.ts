import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

    setResultAnnotation: () => {},
    emit: () => {},
    deliver: () => {},
    putBlob: () => Promise.resolve({ id: "b", bytes: 0, contentType: "text/plain" }),
    request: () => Promise.resolve({}),

    ...over,
  };
}

const oversized = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
const passthrough = (result: ToolResult) => () => Promise.resolve(result);

describe("outputBoundMiddleware", () => {
  it("spills oversized output to a file and shows a head view + pointer", async () => {
    const root = await tmpRoot();
    const ctx = ctxWith({}, new LocalExecutionContext(root));
    const result = await outputBoundMiddleware().wrap(
      { callId: "g", name: "command", args: {} },
      ctx,
      passthrough({ forModel: [{ type: "text", text: oversized }], status: "ok" }),
    );
    const out = text(result.forModel);
    expect(out).toContain("output truncated");
    expect(out).toContain(join(".harness", "conv", "outputs", "out_"));
    expect(out).toContain("line 0"); // head shown
    expect(out).not.toContain("line 999"); // tail elided from the inline view
    const directory = join(root, ".harness", "conv", "outputs");
    const files = await readdir(directory);
    expect(files).toEqual([expect.stringMatching(/^out_/)]);
    expect(await readFile(join(directory, files[0]!), "utf8")).toBe(oversized);
  });

  it("preserves images when accompanying text spills", async () => {
    const image: ContentBlock = {
      type: "image",
      mediaType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    };
    const result = await outputBoundMiddleware().wrap(
      { callId: "image", name: "mcp", args: {} },
      ctxWith({}, new LocalExecutionContext(await tmpRoot())),
      passthrough({ forModel: [{ type: "text", text: oversized }, image], status: "ok" }),
    );
    expect(text(result.forModel)).toContain("output truncated");
    expect(result.forModel.filter((block) => block.type === "image")).toEqual([image]);
  });

  it("writes the UTF-8 of concatenated text even across block boundaries", async () => {
    const root = await tmpRoot();
    const source = ["x".repeat(20_000) + "\ud83d", "\ude80"];
    await outputBoundMiddleware().wrap(
      { callId: "unicode", name: "command", args: {} },
      ctxWith({}, new LocalExecutionContext(root)),
      passthrough({
        status: "ok",
        forModel: source.map((value) => ({ type: "text", text: value })),
      }),
    );
    const directory = join(root, ".harness", "conv", "outputs");
    const [name] = await readdir(directory);
    expect(await readFile(join(directory, name!), "utf8")).toBe(source.join(""));
  });

  it("keeps text exactly at the inline byte limit even when a surrogate pair is split", async () => {
    const source = ["x".repeat(16 * 1024 - 4) + "\ud83d", "\ude80"];
    const result = await outputBoundMiddleware().wrap(
      { callId: "unicode", name: "command", args: {} },
      ctxWith({}, new LocalExecutionContext(await tmpRoot())),
      passthrough({
        status: "ok",
        forModel: source.map((value) => ({ type: "text", text: value })),
      }),
    );
    expect(result.forModel).toEqual(source.map((value) => ({ type: "text", text: value })));
  });

  it("bounds ordinary failures even from tools that normally select their own view", async () => {
    const result = await outputBoundMiddleware().wrap(
      { callId: "r", name: "read_file", args: {} },
      ctxWith({}, new LocalExecutionContext(await tmpRoot())),
      passthrough({ forModel: [{ type: "text", text: oversized }], status: "error" }),
    );
    expect(result.status).toBe("error");
    expect(text(result.forModel)).toContain("full output preserved at");
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
