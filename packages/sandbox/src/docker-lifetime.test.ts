import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  child: undefined as ChildProcess | undefined,
  aborted: false,
  cleanupQueries: 0,
  launchFailure: false,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (bin: string, args: string[], options: { signal?: AbortSignal }) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
    });
    if (bin === "docker" && (args[0] === "ps" || args[0] === "network")) {
      state.cleanupQueries++;
      queueMicrotask(() => child.emit("close", 0));
    } else {
      state.child = child;
      queueMicrotask(() => {
        if (state.launchFailure) {
          child.emit("error", Object.assign(new Error("missing CLI"), { code: "ENOENT" }));
          child.emit("close", -2);
        } else child.emit("spawn");
      });
      options.signal?.addEventListener(
        "abort",
        () => {
          state.aborted = true;
          child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    }
    return child;
  },
}));

const { DockerEnvironmentPool } = await import("./docker-environment.ts");
const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./config.ts");
const { capture } = await import("./docker-cli.ts");
const created: string[] = [];
beforeEach(() => {
  state.child = undefined;
  state.aborted = false;
  state.cleanupQueries = 0;
  state.launchFailure = false;
});
afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Docker process terminal lifetime", () => {
  it("preserves CLI launch failure without attempting resource cleanup", async () => {
    const project = await mkdtemp(join(tmpdir(), "harness-cli-launch-failure-"));
    created.push(project);
    await mkdir(join(project, ".devcontainer"));
    await writeFile(join(project, ".devcontainer", "devcontainer.json"), "{}");
    state.launchFailure = true;
    const context = new DockerExecutionContext(
      project,
      dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 0 }),
    );
    await expect(context.read("file")).rejects.toThrow("devcontainer CLI not found");
    await context.dispose();
    expect(state.cleanupQueries).toBe(0);
  });

  it("preserves missing-config failure and never queries Docker before a CLI starts", async () => {
    const project = await mkdtemp(join(tmpdir(), "harness-missing-config-"));
    created.push(project);
    const context = new DockerExecutionContext(
      project,
      dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 0 }),
    );
    await expect(context.read("file")).rejects.toThrow("no devcontainer config found");
    expect(state.child).toBeUndefined();
    await context.dispose();
    expect(state.cleanupQueries).toBe(0);
  });

  it("server shutdown awaits actual devcontainer close before stopping partial resources", async () => {
    const project = await mkdtemp(join(tmpdir(), "harness-build-lifetime-"));
    created.push(project);
    await mkdir(join(project, ".devcontainer"));
    await writeFile(join(project, ".devcontainer", "devcontainer.json"), "{}");
    const pool = new DockerEnvironmentPool();
    const context = new DockerExecutionContext(
      project,
      dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 0 }),
      pool,
    );
    const io = context.read("file");
    const rejected = expect(io).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(state.child).toBeDefined());
    let disposed = false;
    const disposal = context
      .dispose()
      .then(() => pool.close())
      .then(() => {
        disposed = true;
      });
    await vi.waitFor(() => expect(state.aborted).toBe(true));
    expect(disposed).toBe(false);
    expect(state.cleanupQueries).toBe(0);
    state.child!.emit("close", 1);
    await Promise.all([disposal, rejected]);
    expect(state.cleanupQueries).toBeGreaterThan(0);
  });

  it("does not settle a cancelled IO client before its close event", async () => {
    const controller = new AbortController();
    const io = capture("docker", ["exec", "container", "cat", "file"], {
      signal: controller.signal,
    });
    const rejected = expect(io).rejects.toThrow("aborted");
    let settled = false;
    void io.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    expect(state.aborted).toBe(true);
    expect(settled).toBe(false);
    state.child!.emit("close", 1);
    await rejected;
    expect(settled).toBe(true);
  });
});
