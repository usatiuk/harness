import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, ToolContext, ToolResult } from "@harness/protocol";
import {
  LocalExecutionContext,
  type ExecutionContext,
  type Relationship,
} from "@harness/execution";
import { executionTextEditorTool, TextEditorTool } from "./text-editor.ts";

const created: string[] = [];
async function workspace(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "hwe-"));
  created.push(root);
  const execution = new LocalExecutionContext(root);
  return {
    conversationId: "conv" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    service: (key) => (key === "execution" ? execution : undefined),
    emit: () => {},
    deliver: () => {},
  };
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const text = (r: ToolResult): string =>
  r.forModel.map((b) => (b.type === "text" ? b.text : "")).join("");
const read = (ctx: ToolContext, path: string) =>
  new TextEditorTool().execute({ command: "view", path }, ctx);

class EscalatingTestExecution extends LocalExecutionContext {
  constructor(
    root: string,
    readonly unconfined: ExecutionContext,
  ) {
    super(root);
  }
  registerManagedTool(): void {}
  override classify(): Relationship {
    return "in-workspace";
  }
}

describe("TextEditorTool", () => {
  it("views images without text decoding and rejects image line ranges", async () => {
    const ctx = await workspace();
    const execution = ctx.service("execution") as ExecutionContext;
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    await execution.write("image.png", Buffer.from(data, "base64"));
    expect(await read(ctx, "image.png")).toEqual({
      status: "ok",
      forModel: [{ type: "image", mediaType: "image/png", data }],
    });
    expect(
      await new TextEditorTool().execute(
        { command: "view", path: "image.png", view_range: [1, -1] },
        ctx,
      ),
    ).toMatchObject({ status: "error" });
  });

  it("creates, views, str_replaces, and inserts", async () => {
    const ctx = await workspace();
    const tool = new TextEditorTool();

    const c = await tool.execute(
      { command: "create", path: "f.txt", file_text: "alpha\nbeta\ngamma" },
      ctx,
    );
    expect(c.status).toBe("ok");

    const v = await read(ctx, "f.txt");
    expect(text(v)).toContain("1\talpha");
    expect(text(v)).toContain("3\tgamma");

    const r = await tool.execute(
      { command: "str_replace", path: "f.txt", old_str: "beta", new_str: "BETA" },
      ctx,
    );
    expect(r.status).toBe("ok");

    const i = await tool.execute(
      { command: "insert", path: "f.txt", insert_line: 1, new_str: "inserted" },
      ctx,
    );
    expect(i.status).toBe("ok");

    // view_range slices to lines 1..2 (1-based, inclusive).
    const sliced = await tool.execute({ command: "view", path: "f.txt", view_range: [1, 2] }, ctx);
    expect(text(sliced)).toBe("     1\talpha\n     2\tinserted");
  });

  it("errors when str_replace target is absent or ambiguous", async () => {
    const ctx = await workspace();
    const tool = new TextEditorTool();
    await tool.execute({ command: "create", path: "f.txt", file_text: "x x" }, ctx);

    const absent = await tool.execute(
      { command: "str_replace", path: "f.txt", old_str: "zzz", new_str: "q" },
      ctx,
    );
    expect(absent.status).toBe("error");
    expect(text(absent)).toContain("not found");

    const ambiguous = await tool.execute(
      { command: "str_replace", path: "f.txt", old_str: "x", new_str: "y" },
      ctx,
    );
    expect(ambiguous.status).toBe("error");
    expect(text(ambiguous)).toContain("not unique");
  });

  it("errors when viewing a missing file", async () => {
    const ctx = await workspace();
    const missing = await read(ctx, "nope.txt");
    expect(missing.status).toBe("error");
  });

  it("reports an empty (non-root) directory instead of a read error", async () => {
    const root = await mkdtemp(join(tmpdir(), "hae-"));
    created.push(root);
    const execution = new LocalExecutionContext(root);
    const ctx: ToolContext = {
      conversationId: "conv" as ConversationId,
      callId: "call_0",
      signal: new AbortController().signal,
      service: (key) => (key === "execution" ? execution : undefined),
      emit: () => {},
      deliver: () => {},
    };
    await mkdir(join(root, "empty"));
    const r = await read(ctx, "empty");
    expect(r.status).toBe("ok");
    expect(text(r)).toBe("(empty directory)");
  });

  it("lists a directory for view (Claude's text_editor lists, not reads, dirs)", async () => {
    const ctx = await workspace();
    const tool = new TextEditorTool();
    await tool.execute({ command: "create", path: "src/a.ts", file_text: "a" }, ctx);
    await tool.execute({ command: "create", path: "src/nested/b.ts", file_text: "b" }, ctx);
    await tool.execute({ command: "create", path: "readme.md", file_text: "r" }, ctx);

    const root = await read(ctx, ".");
    expect(root.status).toBe("ok");
    expect(text(root).split("\n")).toEqual(
      expect.arrayContaining(["readme.md", "src", "src/a.ts", "src/nested"]),
    );

    const sub = await read(ctx, "src");
    expect(text(sub).split("\n")).toEqual(expect.arrayContaining(["src/a.ts", "src/nested"]));
  });

  it("owns its function schema and sends an explicitly escalated edit to host execution", async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), "hae-sandbox-"));
    const hostRoot = await mkdtemp(join(tmpdir(), "hae-host-"));
    created.push(sandboxRoot, hostRoot);
    const host = new LocalExecutionContext(hostRoot);
    const sandbox = new EscalatingTestExecution(sandboxRoot, host);
    const tool = executionTextEditorTool(sandbox);
    expect(tool.input.kind).toBe("function");
    if (tool.input.kind !== "function") throw new Error("expected function editor");
    const args = tool.input.schema.parse({
      command: "create",
      path: "escaped.txt",
      file_text: "host",
      sandbox_permissions: "require_escalated",
      justification: "write through the host context",
    });
    const ctx: ToolContext = {
      conversationId: "conv" as ConversationId,
      callId: "call",
      signal: new AbortController().signal,
      service: (key) => (key === "execution" ? sandbox : undefined),
      emit: () => {},
      deliver: () => {},
    };
    expect((await tool.execute(args, ctx)).status).toBe("ok");
    expect(new TextDecoder().decode(await host.read("escaped.txt"))).toBe("host");
    await expect(sandbox.read("escaped.txt")).rejects.toThrow();
  });
});
