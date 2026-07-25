import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeExecutionContext } from "./native.ts";

const probe = spawnSync(
  "bwrap",
  ["--die-with-parent", "--unshare-all", "--share-net", "--ro-bind", "/", "/", "true"],
  { encoding: "utf8" },
);
const bwrapOk = process.platform === "linux" && probe.status === 0;

describe.skipIf(!bwrapOk)("NativeExecutionContext (real Bubblewrap)", () => {
  let root = "";
  let outside = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-native-real-"));
    outside = await mkdtemp(join(tmpdir(), "harness-native-outside-"));
  });

  afterAll(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("writes the rebound workspace but cannot write a sibling host path", async () => {
    const ctx = new NativeExecutionContext(root, { workspaceWrite: true, network: true });
    const proc = ctx.spawn(`printf inside > inside.txt; printf outside > '${outside}/escaped.txt'`);
    const result = await proc.exit;
    expect(result.code).not.toBe(0);
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("inside");
    await expect(stat(join(outside, "escaped.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces a read-only workspace mount", async () => {
    const ctx = new NativeExecutionContext(root, { workspaceWrite: false, network: true });
    const result = await ctx.spawn("printf nope > readonly.txt").exit;
    expect(result.code).not.toBe(0);
    await expect(stat(join(root, "readonly.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
