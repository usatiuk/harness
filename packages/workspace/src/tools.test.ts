import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, ToolContext } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { BashTool, EditTool, GlobTool, GrepTool, ReadFileTool, WriteTool } from "./tools.ts";

const created: string[] = [];
async function workspace(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "hws-"));
  created.push(root);
  return {
    conversationId: "conv" as ConversationId,
    signal: new AbortController().signal,
    execution: new LocalExecutionContext(root),
    emit: () => {},
  };
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function text(result: { forModel: { type: string; text?: string }[] }): string {
  return result.forModel.map((b) => b.text ?? "").join("");
}

describe("workspace tools", () => {
  it("writes then reads back", async () => {
    const ctx = await workspace();
    const w = await new WriteTool().execute({ path: "a.txt", content: "hi" }, ctx);
    expect(w.status).toBe("ok");
    const r = await new ReadFileTool().execute({ path: "a.txt" }, ctx);
    expect(text(r)).toBe("hi");
  });

  it("edits the unique occurrence and rejects missing/ambiguous matches", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "f.txt", content: "one two one" }, ctx);

    const missing = await new EditTool().execute(
      { path: "f.txt", old_string: "zzz", new_string: "x" },
      ctx,
    );
    expect(missing.status).toBe("error");

    const ambiguous = await new EditTool().execute(
      { path: "f.txt", old_string: "one", new_string: "X" },
      ctx,
    );
    expect(ambiguous.status).toBe("error");

    const edited = await new EditTool().execute(
      { path: "f.txt", old_string: "two", new_string: "TWO" },
      ctx,
    );
    expect(edited.status).toBe("ok");
    expect(text(await new ReadFileTool().execute({ path: "f.txt" }, ctx))).toBe("one TWO one");
  });

  it("globs and greps the workspace", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "src/a.ts", content: "needle here" }, ctx);
    await new WriteTool().execute({ path: "src/b.ts", content: "nothing" }, ctx);
    await new WriteTool().execute({ path: "readme.md", content: "needle" }, ctx);

    expect(text(await new GlobTool().execute({ pattern: "src/**/*.ts" }, ctx)).split("\n")).toEqual(
      ["src/a.ts", "src/b.ts"],
    );

    const grep = text(await new GrepTool().execute({ pattern: "needle", path: "src" }, ctx));
    expect(grep).toContain("src/a.ts:1:needle here");
    expect(grep).not.toContain("src/b.ts");
  });

  it("runs a command via bash, surfacing exit status", async () => {
    const ctx = await workspace();
    const okResult = await new BashTool().execute({ command: "echo hi" }, ctx);
    expect(okResult.status).toBe("ok");
    expect(text(okResult)).toContain("hi");

    const failResult = await new BashTool().execute({ command: "exit 2" }, ctx);
    expect(failResult.status).toBe("error");
    expect(text(failResult)).toContain("exit 2");
  });
});
