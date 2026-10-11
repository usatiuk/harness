import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests require a Linux container: a reachable Windows Docker daemon cannot run Debian.
const dockerInfo = spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
  encoding: "utf8",
  windowsHide: true,
});
const dockerOk = dockerInfo.status === 0 && dockerInfo.stdout?.trim() === "linux";

// Stand in for `devcontainer up`: the CLI need not be installed — we point the context at a raw
// container started in `beforeAll`, with a temp dir bind-mounted as the workspace.
const state = vi.hoisted(() => ({
  handle: undefined as
    undefined | { containerId: string; remoteUser: string; remoteWorkspaceFolder: string },
}));
vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: () => Promise.resolve(state.handle!),
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./config.ts");

const te = new TextEncoder();
const td = new TextDecoder();
const config = dockerSandboxConfigSchema.parse({});

describe.skipIf(!dockerOk)("DockerExecutionContext (real container)", () => {
  let cid = "";
  let hostDir = "";

  beforeAll(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "hbox-"));
    const pull = spawnSync("docker", ["pull", "debian:stable-slim"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (pull.status !== 0) {
      throw new Error(
        `docker pull failed: ${pull.stderr?.trim() || pull.error?.message || `exit ${pull.status ?? "unknown"}`}`,
      );
    }
    const run = spawnSync(
      "docker",
      ["run", "-d", "--rm", "-v", `${hostDir}:/work`, "debian:stable-slim", "sleep", "600"],
      { encoding: "utf8", windowsHide: true },
    );
    cid = run.stdout?.trim() ?? "";
    if (run.status !== 0 || !cid) {
      throw new Error(
        `docker run failed: ${run.stderr?.trim() || run.error?.message || (run.status === 0 ? "no container ID returned" : `exit ${run.status ?? "unknown"}`)}`,
      );
    }
    state.handle = { containerId: cid, remoteUser: "root", remoteWorkspaceFolder: "/work" };
  }, 120_000);

  afterAll(async () => {
    // Container runs as root, so its bind-mounted files are root-owned and the host (CI) user can't
    // unlink them — clear /work from inside the container first. Plain-argv `find` handles dotfiles.
    if (cid) {
      spawnSync("docker", ["exec", cid, "find", "/work", "-mindepth", "1", "-delete"], {
        stdio: "ignore",
        windowsHide: true,
      });
      spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore", windowsHide: true });
    }
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

  // Parity with the local backend (see local.test.ts): one shared matcher, identical semantics.
  it("expands braces and excludes dotfiles by default", async () => {
    const c = ctx();
    await c.write("br/a.ts", te.encode(""));
    await c.write("br/d.md", te.encode(""));
    await c.write("br/.hidden.ts", te.encode(""));
    expect(await c.list("br/*.{ts,md}")).toEqual(["br/a.ts", "br/d.md"]);
    expect(await c.list("br/**/*.ts")).toEqual(["br/a.ts"]);
  });

  it("never shell-evaluates a pattern — matching is host-side", async () => {
    const c = ctx();
    // The pattern is filtered host-side and never reaches the container, so a command
    // substitution in it can neither match nor execute.
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

  it("classifies only registered execution-backed tools as in-workspace", () => {
    const c = ctx();
    c.registerManagedTool("bash");
    expect(c.classify({ callId: "1", name: "bash", args: {} })).toBe("in-workspace");
    expect(c.classify({ callId: "2", name: "remote_tool", args: {} })).toBe("unknown");
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
