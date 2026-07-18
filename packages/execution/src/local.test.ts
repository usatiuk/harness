import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@harness/protocol";
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

describe("LocalExecutionContext", () => {
  it("writes then reads back through the workspace (creating parent dirs)", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    await ctx.write("sub/a.txt", te.encode("hello"));
    expect(td.decode(await ctx.read("sub/a.txt"))).toBe("hello");
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

  it.runIf(process.platform === "win32")("preserves native Windows exit codes", async () => {
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
  });

  it("advertises the host shell and preserves UTF-8 command output", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    expect(ctx.shellKind).toBe(process.platform === "win32" ? "powershell" : "bash");
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
    expect(ctx.classify(call({ command: "ls" }))).toBe("out-of-workspace"); // no path arg
  });

  it("treats everything as out-of-workspace when projectless", () => {
    expect(new LocalExecutionContext(null).classify(call({ path: "a" }))).toBe("out-of-workspace");
  });
});
