import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  probeStatus: 0,
  probeStderr: "",
  spawnArgs: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: () => ({
    status: state.probeStatus,
    stderr: state.probeStderr,
    stdout: "",
  }),
  spawn: (_bin: string, args: string[]) => {
    state.spawnArgs = args;
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 42,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    return child;
  },
}));

const { NativeExecutionContext } = await import("./native.ts");

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "harness-native-"));
  roots.push(root);
  return root;
};

beforeEach(() => {
  state.probeStatus = 0;
  state.probeStderr = "";
  state.spawnArgs = [];
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("NativeExecutionContext", () => {
  it("fails immediately when Bubblewrap is unusable", async () => {
    state.probeStatus = 1;
    state.probeStderr = "namespace denied";
    const root = await makeRoot();
    expect(() => new NativeExecutionContext(root, { workspaceWrite: true, network: true })).toThrow(
      /usable bubblewrap.*namespace denied/,
    );
  });

  it("rejects a workspace that would replace the private temp/runtime mounts", () => {
    expect(() => new NativeExecutionContext("/", { workspaceWrite: true, network: true })).toThrow(
      /cannot contain its private/,
    );
  });

  it("builds a read-host/write-workspace Bubblewrap command with optional network", async () => {
    const root = await makeRoot();
    const ctx = new NativeExecutionContext(root, { workspaceWrite: true, network: false });
    ctx.spawn("echo hi");
    expect(state.spawnArgs).toEqual([
      "--die-with-parent",
      "--unshare-all",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "TMP",
      "/tmp",
      "--setenv",
      "TEMP",
      "/tmp",
      "--bind",
      root,
      root,
      "--chdir",
      root,
      "--",
      "bash",
      "-c",
      "echo hi",
    ]);
    expect(state.spawnArgs).not.toContain("--share-net");
  });

  it("allows workspace writes but denies outside and symlink escapes", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const ctx = new NativeExecutionContext(root, { workspaceWrite: true, network: true });
    await ctx.write("inside.txt", new TextEncoder().encode("inside"));
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("inside");
    await expect(ctx.write(join(outside, "x"), new Uint8Array())).rejects.toMatchObject({
      code: "EACCES",
    });
    await symlink(outside, join(root, "escape"));
    await expect(ctx.write("escape/x", new Uint8Array())).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("denies all built-in writes when workspace write is disabled", async () => {
    const root = await makeRoot();
    const ctx = new NativeExecutionContext(root, { workspaceWrite: false, network: true });
    await expect(ctx.write("x", new Uint8Array())).rejects.toMatchObject({ code: "EACCES" });
  });

  it("classifies only registered execution calls and recognizes both escalation encodings", async () => {
    const root = await makeRoot();
    const ctx = new NativeExecutionContext(root, { workspaceWrite: true, network: true });
    ctx.registerManagedTool("bash");
    ctx.registerManagedTool("apply_patch");
    expect(ctx.classify({ callId: "1", name: "bash", args: { command: "ls" } })).toBe(
      "in-workspace",
    );
    expect(
      ctx.classify({
        callId: "2",
        name: "bash",
        args: {
          command: "ls",
          sandbox_permissions: "require_escalated",
          justification: "host",
        },
      }),
    ).toBe("out-of-workspace");
    expect(
      ctx.classify({
        callId: "3",
        name: "apply_patch",
        args: "sandbox_permissions=require_escalated\njustification=host\n---\n*** Begin Patch\n*** End Patch",
      }),
    ).toBe("out-of-workspace");
    expect(ctx.classify({ callId: "4", name: "web_search", args: {} })).toBe("unknown");
  });
});
