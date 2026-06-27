import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, FileToolsProfile, ToolContext, ToolResult } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { ActivityManager, activitiesOf, consume } from "@harness/activities";
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
  const manager = new ActivityManager("conv" as ConversationId);
  const execution = new LocalExecutionContext(root);
  return {
    conversationId: "conv" as ConversationId,
    callId: "call_0",
    signal: new AbortController().signal,
    service: (key) =>
      key === "activities" ? manager : key === "execution" ? execution : undefined,
    emit: () => {},
    deliver: () => {},
  };
}

/**
 * Drives bash the way the engine does: the tool mints + tracks an activity (returning a
 * placeholder), then the consumption layer claims it by callId and produces the real result.
 */
async function runBash(ctx: ToolContext, command: string): Promise<ToolResult> {
  const mgr = activitiesOf(ctx);
  await new BashTool().execute({ command }, ctx);
  const activity = mgr.claim(ctx.callId);
  if (!activity) throw new Error("bash did not register an activity");
  return consume(mgr, activity, false, ctx);
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

    // POSIX ERE: alternation/grouping resolves server-side via `grep -E`, path-scoped to `src`.
    const grep = text(await new GrepTool().execute({ pattern: "need(le|x)", path: "src" }, ctx));
    expect(grep).toContain("src/a.ts:1:needle here");
    expect(grep).not.toContain("src/b.ts");
  });

  it("grep skips dot-directories (e.g. the .harness output store), not just .git", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "src/a.ts", content: "needle here" }, ctx);
    await new WriteTool().execute({ path: ".harness/conv/outputs/x.log", content: "needle" }, ctx);
    await new WriteTool().execute({ path: ".git/MERGE_MSG", content: "needle" }, ctx);
    const grep = text(await new GrepTool().execute({ pattern: "needle", path: "." }, ctx));
    expect(grep).toContain("src/a.ts:1:needle here");
    expect(grep).not.toContain(".harness");

    // …but an explicit path INTO a skipped dir is honored — the agent can still grep git internals.
    const inGit = text(await new GrepTool().execute({ pattern: "needle", path: ".git" }, ctx));
    expect(inGit).toContain(".git/MERGE_MSG:1:needle");
  });

  it("runs a quick command as an activity, surfacing exit status inline", async () => {
    const ctx = await workspace();
    const okResult = await runBash(ctx, "echo hi");
    expect(okResult.status).toBe("ok");
    expect(text(okResult)).toContain("hi");

    const failResult = await runBash(ctx, "exit 2");
    expect(failResult.status).toBe("error");
    expect(text(failResult)).toContain("exited 2");
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
