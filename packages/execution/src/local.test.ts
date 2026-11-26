import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@harness/protocol";
import { selectUserShell } from "./shell.ts";
import { LocalExecutionContext } from "./local.ts";

const td = new TextDecoder();
const te = new TextEncoder();
const created: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hexec-"));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const call = (args: unknown): ToolCall => ({ callId: "c", name: "x", args });

describe("local output artifacts", () => {
  it("allows a project directory alias without replacing the owner's ignore file or existing logs", async () => {
    const fixture = await tmp();
    const project = join(fixture, "target");
    const alias = join(fixture, "project");
    const marker = join(project, ".harness", ".gitignore");
    await mkdir(join(project, ".harness"), { recursive: true });
    await writeFile(marker, "# kept\n");
    await symlink(project, alias, "junction");
    const store = new LocalExecutionContext(alias).outputStore("conversation-1");
    const path = await store.put("captured", "first");
    await expect(store.put("captured", "second")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.open("captured").close("third")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("first");
    expect(await readFile(marker, "utf8")).toBe("# kept\n");
  });

  it.each([0, 1, 2])("rejects a linked output directory at depth %d", async (depth) => {
    const fixture = await tmp();
    const project = join(fixture, "project");
    const other = join(fixture, "other");
    const parts = [".harness", "conversation", "outputs"];
    const parent = join(project, ...parts.slice(0, depth));
    await mkdir(parent, { recursive: true });
    await mkdir(other);
    await symlink(other, join(parent, parts[depth]!), "junction");
    const store = new LocalExecutionContext(project).outputStore("conversation");
    await expect(store.put("capture", "unwritten")).rejects.toThrow();
    expect(await readdir(other)).toEqual([]);
  });

  it("never writes through linked markers or log entries", async () => {
    const fixture = await tmp();
    const harness = join(fixture, ".harness");
    const outputs = join(harness, "conversation", "outputs");
    const marker = join(harness, ".gitignore");
    const other = join(fixture, "other");
    await mkdir(outputs, { recursive: true });
    await mkdir(other);
    await symlink(other, marker, "junction");
    const store = new LocalExecutionContext(fixture).outputStore("conversation");
    await expect(store.put("blocked", "unexpected")).rejects.toThrow();
    expect(await readdir(outputs)).toEqual([]);
    await rm(marker);
    const existing = join(other, "existing");
    await writeFile(existing, "original");
    await link(existing, join(outputs, "capture.log"));
    await expect(store.open("capture").close("unwritten")).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(existing, "utf8")).toBe("original");
  });
});

describe("LocalExecutionContext", () => {
  it("writes then reads back through the workspace (creating parent dirs)", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    await ctx.write("sub/a.txt", te.encode("hello"));
    expect(td.decode(await ctx.read("sub/a.txt"))).toBe("hello");
  });

  it("reads bounded byte ranges and stops at end of file", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    await ctx.write("range.txt", te.encode("0123456789"));
    expect(td.decode(await ctx.read("range.txt", { offset: 2, length: 3 }))).toBe("234");
    expect(td.decode(await ctx.read("range.txt", { offset: 8, length: 5 }))).toBe("89");
    expect(await ctx.read("range.txt", { offset: 12, length: 5 })).toHaveLength(0);
    expect(await ctx.read("range.txt", { offset: 0, length: 0 })).toHaveLength(0);
  });

  it("lists workspace-relative paths matching a glob", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    await ctx.write("a.ts", te.encode(""));
    await ctx.write("b/c.ts", te.encode(""));
    await ctx.write("d.md", te.encode(""));
    expect(await ctx.list("**/*.ts")).toEqual(["a.ts", "b/c.ts"]);
  });

  // The matcher (minimatch, dot:false) is shared with the docker backend, so these semantics —
  // brace expansion and dotfile exclusion — must hold identically there (see docker.test.ts).
  it("expands braces and excludes dotfiles by default", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    await ctx.write("a.ts", te.encode(""));
    await ctx.write("d.md", te.encode(""));
    await ctx.write(".hidden.ts", te.encode(""));
    await ctx.write(".dir/e.ts", te.encode(""));
    expect(await ctx.list("*.{ts,md}")).toEqual(["a.ts", "d.md"]);
    expect(await ctx.list("**/*.ts")).toEqual(["a.ts"]);
  });

  it("spawns a command in the workspace root, streaming output and reporting exit codes", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    const ok = ctx.spawn("echo hi");
    let out = "";
    ok.onData((chunk) => (out += chunk));
    expect((await ok.exit).code).toBe(0);
    expect(out.trim()).toBe("hi");
    expect((await ctx.spawn("exit 3").exit).code).toBe(3);
  }, 15_000);

  it.runIf(process.platform === "win32")(
    "preserves native Windows exit codes",
    async () => {
      const ctx = new LocalExecutionContext(await tmp());
      const proc = ctx.spawn(`& "${process.execPath}" -e "process.exit(7)"`);
      expect((await proc.exit).code).toBe(7);

      const recovered = ctx.spawn(
        `& "${process.execPath}" -e "process.exit(7)"; Write-Output recovered`,
      );
      let output = "";
      recovered.onData((chunk) => (output += chunk));
      expect((await recovered.exit).code).toBe(0);
      expect(output.trim()).toBe("recovered");

      const cmdletFailure = ctx.spawn(
        `& "${process.execPath}" -e "process.exit(0)"; Get-Item -LiteralPath '__missing__'`,
      );
      expect((await cmdletFailure.exit).code).toBe(1);
    },
    15_000,
  );

  it("advertises the host shell and preserves UTF-8 command output", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    expect(ctx.shellKind).toBe(
      process.platform === "win32" ? "powershell" : selectUserShell().kind,
    );
    const invoke =
      ctx.shellKind === "powershell" ? `& "${process.execPath}"` : `"${process.execPath}"`;
    const proc = ctx.spawn(`${invoke} -e "console.log('žluťoučký')"`);
    let out = "";
    proc.onData((chunk) => (out += chunk));
    expect((await proc.exit).code).toBe(0);
    expect(out).toContain("žluťoučký");

    const pipeline = ctx.spawn(
      ctx.shellKind === "powershell"
        ? `'žluťoučký' | ${invoke} -e "process.stdin.pipe(process.stdout)"`
        : `printf '%s' 'žluťoučký' | ${invoke} -e "process.stdin.pipe(process.stdout)"`,
    );
    let piped = "";
    pipeline.onData((chunk) => (piped += chunk));
    expect((await pipeline.exit).code).toBe(0);
    expect(piped).toContain("žluťoučký");
  });

  it("classifies by path containment", () => {
    const ctx = new LocalExecutionContext("/work");
    expect(ctx.classify(call({ path: "src/x.ts" }))).toBe("in-workspace");
    expect(ctx.classify(call({ path: "..safe/x.ts" }))).toBe("in-workspace");
    expect(ctx.classify(call({ path: "../escape" }))).toBe("out-of-workspace");
    expect(ctx.classify(call({ path: "/etc/passwd" }))).toBe("out-of-workspace");
    expect(ctx.classify(call({ command: "ls" }))).toBe("unknown"); // no path arg
  });

  it("cannot classify paths when projectless", () => {
    expect(new LocalExecutionContext(null).classify(call({ path: "a" }))).toBe("unknown");
  });
});
