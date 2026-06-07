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

  it("runs a command in the workspace root, reporting exit codes", async () => {
    const ctx = new LocalExecutionContext(await tmp());
    const ok = await ctx.run("echo hi");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe("hi");
    expect((await ctx.run("exit 3")).exitCode).toBe(3);
  });

  it("classifies by path containment", () => {
    const ctx = new LocalExecutionContext("/work");
    expect(ctx.classify(call({ path: "src/x.ts" }))).toBe("in-workspace");
    expect(ctx.classify(call({ path: "../escape" }))).toBe("out-of-workspace");
    expect(ctx.classify(call({ path: "/etc/passwd" }))).toBe("out-of-workspace");
    expect(ctx.classify(call({ command: "ls" }))).toBe("out-of-workspace"); // no path arg
  });

  it("treats everything as out-of-workspace when projectless", () => {
    expect(new LocalExecutionContext(null).classify(call({ path: "a" }))).toBe("out-of-workspace");
  });
});
