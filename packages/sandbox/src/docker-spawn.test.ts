import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ children: [] as ChildProcess[] }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 42,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    state.children.push(child);
    return child;
  }),
}));

vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: () =>
    Promise.resolve({ containerId: "container", remoteUser: "root", remoteWorkspaceFolder: "/w" }),
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./config.ts");

describe("DockerExecutionContext spawn", () => {
  it("ignores kill after the Docker client has exited but before stdio closes", async () => {
    state.children.length = 0;
    const ctx = new DockerExecutionContext(
      "/workspace",
      dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 0 }),
    );
    const proc = ctx.spawn("echo done");
    await vi.waitFor(() => expect(state.children).toHaveLength(1));
    const child = state.children[0]!;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      child.emit("exit", 0, null);
      proc.kill();

      expect(kill).not.toHaveBeenCalled();
      child.emit("close", 0, null);
      await expect(proc.exit).resolves.toMatchObject({ code: 0, signal: null });
    } finally {
      kill.mockRestore();
    }
  });
});
