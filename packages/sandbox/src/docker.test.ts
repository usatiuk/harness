import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests exercise the real `docker exec` IO path; skipped where the daemon isn't reachable.
const dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// Stand in for `devcontainer up`: the CLI need not be installed — we point the context at a raw
// container started in `beforeAll`, with a temp dir bind-mounted as the workspace.
const state = vi.hoisted(() => ({
  handle: undefined as
    | undefined
    | { containerId: string; remoteUser: string; remoteWorkspaceFolder: string },
}));
vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: () => Promise.resolve(state.handle!),
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { sandboxConfigSchema } = await import("./plugin.ts");

const te = new TextEncoder();
const td = new TextDecoder();
const config = sandboxConfigSchema.parse({ enabled: true });

describe.skipIf(!dockerOk)("DockerExecutionContext (real container)", () => {
  let cid = "";
  let hostDir = "";

  beforeAll(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "hbox-"));
    spawnSync("docker", ["pull", "debian:stable-slim"], { stdio: "ignore" });
    const run = spawnSync(
      "docker",
      ["run", "-d", "--rm", "-v", `${hostDir}:/work`, "debian:stable-slim", "sleep", "600"],
      { encoding: "utf8" },
    );
    cid = run.stdout.trim();
    state.handle = { containerId: cid, remoteUser: "root", remoteWorkspaceFolder: "/work" };
  }, 120_000);

  afterAll(async () => {
    if (cid) spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    if (hostDir) await rm(hostDir, { recursive: true, force: true });
  });

  const ctx = (): InstanceType<typeof DockerExecutionContext> =>
    new DockerExecutionContext(hostDir, config);

  it("writes then reads back through the container (creating parent dirs)", async () => {
    const c = ctx();
    await c.write("sub/a.txt", te.encode("hello"));
    expect(td.decode(await c.read("sub/a.txt"))).toBe("hello");
  });

  it("reads a byte range", async () => {
    const c = ctx();
    await c.write("r.txt", te.encode("0123456789"));
    expect(td.decode(await c.read("r.txt", { offset: 2, length: 3 }))).toBe("234");
  });

  it("stat distinguishes file, directory, and absent", async () => {
    const c = ctx();
    await c.write("d/f.txt", te.encode("x"));
    expect(await c.stat("d")).toEqual({ isDirectory: true });
    expect(await c.stat("d/f.txt")).toEqual({ isDirectory: false });
    expect(await c.stat("nope")).toBeUndefined();
  });

  it("lists workspace-relative paths matching a glob", async () => {
    const c = ctx();
    await c.write("g/a.ts", te.encode(""));
    await c.write("g/b/c.ts", te.encode(""));
    await c.write("g/d.md", te.encode(""));
    expect(await c.list("g/**/*.ts")).toEqual(["g/a.ts", "g/b/c.ts"]);
  });

  it("globs a pattern with spaces as one glob (no word splitting)", async () => {
    const c = ctx();
    await c.write("sp ace/x.ts", te.encode(""));
    expect(await c.list("sp ace/*.ts")).toEqual(["sp ace/x.ts"]);
  });

  it("treats a glob pattern literally — never shell-evaluates it", async () => {
    const c = ctx();
    // A command substitution in the pattern must be matched as literal glob chars, not executed.
    expect(await c.list("inj/$(touch pwned).ts")).toEqual([]);
    expect(await c.stat("pwned")).toBeUndefined();
  });

  it("remove deletes a file and errors when absent", async () => {
    const c = ctx();
    await c.write("rm.txt", te.encode("x"));
    await c.remove("rm.txt");
    expect(await c.stat("rm.txt")).toBeUndefined();
    await expect(c.remove("rm.txt")).rejects.toThrow();
  });

  it("reaches container-only files outside the workspace", async () => {
    expect(td.decode(await ctx().read("/etc/hostname"))).toContain(cid.slice(0, 12));
  });

  it("classifies every call as in-workspace (container is the boundary)", () => {
    expect(ctx().classify()).toBe("in-workspace");
  });

  it("spawn streams output and completes", async () => {
    const proc = ctx().spawn("echo streamed");
    let out = "";
    proc.onData((chunk) => (out += chunk));
    const res = await proc.exit;
    expect(out).toContain("streamed");
    expect(res.code).toBe(0);
  });
});
