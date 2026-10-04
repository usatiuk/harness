import { beforeEach, describe, expect, it, vi } from "vitest";

// No docker daemon: `provisionDevcontainer` hands back a fixed handle (and counts how many times it
// runs, so we can prove a re-provision happened), and `docker exec` is a spy we steer per call.
const state = vi.hoisted(() => ({
  handle: { containerId: "cid", remoteUser: "root", remoteWorkspaceFolder: "/work" },
  provisions: 0,
  captureText:
    vi.fn<
      (
        bin: string,
        args: string[],
        opts?: unknown,
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    >(),
}));

vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: () => {
    state.provisions++;
    return Promise.resolve(state.handle);
  },
  stopSandbox: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("./docker-cli.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-cli.ts")>()),
  captureText: state.captureText,
  capture: () => Promise.resolve({ stdout: Buffer.from(""), stderr: "", exitCode: 0 }),
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./config.ts");

// Idle reaping off — these tests are about the exec retry path, not the timer.
const make = () =>
  new DockerExecutionContext("/work", dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 0 }));

const gone = { stdout: "", stderr: "Error: No such container: cid", exitCode: 1 };
const ok = { stdout: "", stderr: "", exitCode: 0 };

beforeEach(() => {
  state.provisions = 0;
  state.captureText.mockReset();
});

describe("DockerExecutionContext retry-on-stale", () => {
  it("re-provisions and retries once when the container vanished out-of-band", async () => {
    state.captureText.mockResolvedValueOnce(gone).mockResolvedValueOnce(ok);
    await expect(make().remove("x")).resolves.toBeUndefined(); // self-healed, no surfaced failure
    expect(state.provisions).toBe(2); // dropped the stale handle and provisioned a fresh container
    expect(state.captureText).toHaveBeenCalledTimes(2);
  });

  it("does not retry a normal (non-gone) failure", async () => {
    state.captureText.mockResolvedValue({
      stdout: "",
      stderr: "rm: permission denied",
      exitCode: 1,
    });
    await expect(make().remove("x")).rejects.toThrow(/remove failed/);
    expect(state.provisions).toBe(1); // no re-provision
    expect(state.captureText).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once, then surfaces the failure if the container is still gone", async () => {
    state.captureText.mockResolvedValue(gone);
    await expect(make().remove("x")).rejects.toThrow(/remove failed/);
    expect(state.provisions).toBe(2); // one retry, not an infinite loop
    expect(state.captureText).toHaveBeenCalledTimes(2);
  });
});
