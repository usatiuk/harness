import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGE_BYTES,
  type ConversationId,
  type FileToolsProfile,
  type ToolContext,
  type ToolResult,
} from "@harness/protocol";
import {
  LocalExecutionContext,
  type ExecutionContext,
  type Relationship,
} from "@harness/execution";
import { ActivityManager, activitiesOf, consume } from "@harness/activities";
import {
  ApplyPatchTool,
  CommandTool,
  EditTool,
  GlobTool,
  ReadFileTool,
  WriteTool,
  executionApplyPatchTool,
  scopedPattern,
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
 * Drives the active command tool the way the engine does: the tool mints + tracks an activity (returning a
 * placeholder), then the consumption layer claims it by callId and produces the real result.
 */
async function runCommand(ctx: ToolContext, command: string): Promise<ToolResult> {
  const mgr = activitiesOf(ctx);
  const execution = ctx.service("execution") as LocalExecutionContext;
  await new CommandTool(execution.shellKind).execute({ command }, ctx);
  const activity = mgr.claim(ctx.callId);
  if (!activity) throw new Error("command did not register an activity");
  return consume(mgr, activity, false, ctx);
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function text(result: { forModel: { type: string; text?: string }[] }): string {
  return result.forModel.map((b) => b.text ?? "").join("");
}

class EscalatingTestExecution extends LocalExecutionContext {
  readonly managed = new Set<string>();
  constructor(
    root: string,
    readonly unconfined: ExecutionContext,
  ) {
    super(root);
  }
  registerManagedTool(name: string): void {
    this.managed.add(name);
  }
  override classify(): Relationship {
    return "in-workspace";
  }
}

describe("workspace tools", () => {
  it("writes then reads back", async () => {
    const ctx = await workspace();
    const w = await new WriteTool().execute({ path: "a.txt", content: "hi" }, ctx);
    expect(w.status).toBe("ok");
    const r = await new ReadFileTool().execute({ path: "a.txt" }, ctx);
    expect(text(r)).toBe("hi");
  });

  it("reads an image as image content regardless of its filename", async () => {
    const ctx = await workspace();
    const execution = ctx.service("execution") as ExecutionContext;
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    await execution.write("screenshot.bin", Buffer.from(data, "base64"));
    expect(await new ReadFileTool().execute({ path: "screenshot.bin" }, ctx)).toEqual({
      status: "ok",
      forModel: [{ type: "image", mediaType: "image/png", data }],
    });
    expect(
      await new ReadFileTool().execute({ path: "screenshot.bin", offset: 0 }, ctx),
    ).toMatchObject({ status: "error" });
  });

  it("rejects oversized images after a bounded read", async () => {
    const ctx = await workspace();
    const execution = ctx.service("execution") as ExecutionContext;
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    await execution.write("large.png", bytes);
    expect(await new ReadFileTool().execute({ path: "large.png" }, ctx)).toMatchObject({
      status: "error",
    });
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

  it("parses apply_patch's explicit header and delegates only that call outside the sandbox", async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), "hws-sandbox-"));
    const hostRoot = await mkdtemp(join(tmpdir(), "hws-host-"));
    created.push(sandboxRoot, hostRoot);
    const host = new LocalExecutionContext(hostRoot);
    const sandbox = new EscalatingTestExecution(sandboxRoot, host);
    const tool = executionApplyPatchTool(sandbox);
    if (tool.input.kind !== "custom") throw new Error("expected custom apply_patch tool");
    const args = tool.input.parse(
      "sandbox_permissions=require_escalated\n" +
        "justification=write through the host context\n---\n" +
        "*** Begin Patch\n*** Add File: escaped.txt\n+host\n*** End Patch\n",
    );
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
    expect(sandbox.managed).toContain("apply_patch");
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

  it("globs the workspace", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "src/a.ts", content: "needle here" }, ctx);
    await new WriteTool().execute({ path: "src/b.ts", content: "nothing" }, ctx);
    await new WriteTool().execute({ path: "readme.md", content: "needle" }, ctx);

    expect(text(await new GlobTool().execute({ pattern: "src/**/*.ts" }, ctx)).split("\n")).toEqual(
      ["src/a.ts", "src/b.ts"],
    );
  });

  it("glob treats path '.' as the whole workspace, not a literal './' prefix", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "src/a.ts", content: "" }, ctx);
    await new WriteTool().execute({ path: "readme.md", content: "" }, ctx);

    // Regression: `path: "."` built `./**/*`, but `list` returns workspace-relative paths with no
    // `./` prefix, so it matched nothing. "." must mean the whole workspace (matching the tool's
    // own description and the other workspace tools' convention).
    expect(text(await new GlobTool().execute({ pattern: "**/*.md", path: "." }, ctx))).toBe(
      "readme.md",
    );
    expect(text(await new GlobTool().execute({ pattern: "**/*.md" }, ctx))).toBe("readme.md");
  });

  it("glob scopes by path robustly: './src', 'src/' and 'src' all behave like 'src'", async () => {
    const ctx = await workspace();
    await new WriteTool().execute({ path: "src/a.ts", content: "" }, ctx);
    await new WriteTool().execute({ path: "other/b.ts", content: "" }, ctx);

    for (const path of ["src", "src/", "./src"]) {
      expect(text(await new GlobTool().execute({ pattern: "**/*.ts", path }, ctx))).toBe(
        "src/a.ts",
      );
    }
  });

  it("runs a quick command as an activity, surfacing exit status inline", async () => {
    const ctx = await workspace();
    const okResult = await runCommand(ctx, "echo hi");
    expect(okResult.status).toBe("ok");
    expect(text(okResult)).toContain("hi");

    const failResult = await runCommand(ctx, "exit 2");
    expect(failResult.status).toBe("error");
    expect(text(failResult)).toContain("exited 2");
  });
});

describe("workspacePlugin file-tools roster by profile", () => {
  const names = (fileTools: FileToolsProfile, shellKind: "bash" | "powershell" = "bash") =>
    workspacePlugin.tools!(
      { contentTypes: ["text"], toolCalling: true, fileTools },
      { service: () => ({ shellKind }) },
    ).map((t) => t.name);

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

  it("gives the workspace-owned text editor to a text_editor model", () => {
    const ns = names("text_editor");
    expect(ns).not.toContain("read_file");
    expect(ns).not.toContain("write");
    expect(ns).not.toContain("edit");
    expect(ns).not.toContain("apply_patch");
    expect(ns).toEqual(expect.arrayContaining(["glob", "bash", "str_replace_based_edit_tool"]));
    expect(names("text_editor", "powershell")).toEqual(
      expect.arrayContaining(["glob", "powershell", "str_replace_based_edit_tool"]),
    );
    expect(ns).not.toContain("grep");
  });
});

describe("scopedPattern", () => {
  // `list` matches workspace-relative paths with no `./` prefix, so the effective glob must be in
  // that convention. Each row: [pattern, path] → expected combined glob.
  const cases: Array<[string, string | undefined, string]> = [
    ["**/*.ts", undefined, "**/*.ts"], // omitted → whole workspace
    ["**/*.ts", ".", "**/*.ts"], // "." → whole workspace
    ["**/*.ts", "", "**/*.ts"], // empty → whole workspace (not "/**/*.ts")
    ["**/*.ts", "./", "**/*.ts"], // "./" → whole workspace
    ["**/*.ts", "src", "src/**/*.ts"], // bare dir scope
    ["**/*.ts", "src/", "src/**/*.ts"], // trailing slash stripped
    ["**/*.ts", "./src", "src/**/*.ts"], // leading "./" stripped
    ["./**/*.ts", undefined, "**/*.ts"], // leading "./" on the pattern stripped too
    ["./**/*.ts", "src", "src/**/*.ts"],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`pattern=${pattern} path=${String(path)} → ${expected}`, () => {
      expect(scopedPattern(pattern, path)).toBe(expected);
    });
  }
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
