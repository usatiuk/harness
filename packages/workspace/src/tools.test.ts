import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, FileToolsProfile, ToolContext } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import {
  ApplyPatchTool,
  BashTool,
  EditTool,
  GlobTool,
  GrepTool,
  ReadFileTool,
  WriteTool,
} from "./tools.ts";
import { parseEnvelope } from "./apply-patch-parse.ts";
import { workspacePlugin } from "./index.ts";

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

  // ApplyPatchTool receives changes already parsed from the V4A envelope by the kernel
  // (`parseEnvelope`); these tests feed it the same parsed form.
  it("applies create/update/delete patches from a V4A envelope and reports bad diffs", async () => {
    const ctx = await workspace();
    const tool = new ApplyPatchTool();
    const apply = (patch: string) => tool.execute(parseEnvelope(patch), ctx);
    const read = () => new ReadFileTool().execute({ path: "f.txt" }, ctx);

    const created = await apply(
      "*** Begin Patch\n*** Add File: f.txt\n+alpha\n+beta\n+gamma\n*** End Patch\n",
    );
    expect(created.status).toBe("ok");
    expect(text(await read())).toBe("alpha\nbeta\ngamma");

    const updated = await apply(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n*** End Patch\n",
    );
    expect(updated.status).toBe("ok");
    expect(text(await read())).toBe("alpha\nBETA\ngamma");

    const bad = await apply(
      "*** Begin Patch\n*** Update File: f.txt\n@@\n nope\n-zzz\n+q\n*** End Patch\n",
    );
    expect(bad.status).toBe("error");

    const deleted = await apply("*** Begin Patch\n*** Delete File: f.txt\n*** End Patch\n");
    expect(deleted.status).toBe("ok");
    await expect(read()).rejects.toThrow();
  });

  it("applies a multi-file envelope in one call", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "keep.txt", content: "old\n" }, ctx);
    const result = await new ApplyPatchTool().execute(
      parseEnvelope(
        "*** Begin Patch\n" +
          "*** Add File: new.txt\n+fresh\n" +
          "*** Update File: keep.txt\n@@\n-old\n+new\n" +
          "*** End Patch\n",
      ),
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(text(await new ReadFileTool().execute({ path: "new.txt" }, ctx))).toBe("fresh");
    expect(text(await new ReadFileTool().execute({ path: "keep.txt" }, ctx))).toBe("new\n");
  });

  it("edit replaces a unique occurrence and errors on absent/ambiguous matches", async () => {
    const ctx = await workspace();
    const tool = new EditTool();
    await new WriteTool().execute({ path: "f.txt", content: "one two two\n" }, ctx);

    const missing = await tool.execute({ path: "f.txt", old_string: "zzz", new_string: "q" }, ctx);
    expect(missing.status).toBe("error");
    expect(text(missing)).toContain("not found");

    const ambiguous = await tool.execute(
      { path: "f.txt", old_string: "two", new_string: "x" },
      ctx,
    );
    expect(ambiguous.status).toBe("error");
    expect(text(ambiguous)).toContain("not unique");

    const ok = await tool.execute({ path: "f.txt", old_string: "one", new_string: "1" }, ctx);
    expect(ok.status).toBe("ok");
    expect(text(await new ReadFileTool().execute({ path: "f.txt" }, ctx))).toBe("1 two two\n");
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

describe("workspacePlugin file-tools roster by profile", () => {
  const names = (fileTools: FileToolsProfile) =>
    workspacePlugin.tools!({ contentTypes: ["text"], toolCalling: true, fileTools }).map(
      (t) => t.name,
    );

  it("gives apply_patch (with read/write) to a V4A model", () => {
    expect(names("apply_patch")).toEqual(
      expect.arrayContaining(["read_file", "write", "apply_patch"]),
    );
    expect(names("apply_patch")).not.toContain("edit");
  });

  it("gives edit (with read/write) to a string_replace model", () => {
    expect(names("string_replace")).toEqual(expect.arrayContaining(["read_file", "write", "edit"]));
    expect(names("string_replace")).not.toContain("apply_patch");
  });

  it("gives no read/write/edit to a text_editor model (the native editor replaces them)", () => {
    const ns = names("text_editor");
    expect(ns).not.toContain("read_file");
    expect(ns).not.toContain("write");
    expect(ns).not.toContain("edit");
    expect(ns).not.toContain("apply_patch");
    // search + bash remain.
    expect(ns).toEqual(expect.arrayContaining(["glob", "grep", "bash"]));
  });
});

describe("parseEnvelope", () => {
  it("throws on an envelope with no markers", () => {
    expect(() => parseEnvelope("no markers here")).toThrow(/Begin Patch/);
  });

  it("throws on an unrecognized line inside the envelope", () => {
    expect(() => parseEnvelope("*** Begin Patch\ngarbage\n*** End Patch\n")).toThrow(
      /unexpected line/,
    );
  });
});
