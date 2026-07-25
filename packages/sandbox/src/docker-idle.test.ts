import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// No docker daemon: the container handle is a fixed stub, and the docker CLI is spied so we can
// assert (and steer) the idle reaper's `docker stop` / pty-probe calls. A fake child stands in for
// `nodeSpawn` so a "running command" can be held in flight.
const state = vi.hoisted(() => ({
  handle: { containerId: "cid", remoteUser: "root", remoteWorkspaceFolder: "/work" },
  child: undefined as undefined | EventEmitter,
  captureText:
    vi.fn<
      (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    >(),
}));
const captureText = state.captureText;

vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: () => Promise.resolve(state.handle),
  stopSandbox: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("./docker-cli.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-cli.ts")>()),
  captureText: state.captureText,
  capture: () => Promise.resolve({ stdout: Buffer.from(""), stderr: "", exitCode: 0 }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => state.child,
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./plugin.ts");

const make = (over: Record<string, unknown> = {}) =>
  new DockerExecutionContext("/work", dockerSandboxConfigSchema.parse(over));

/** The `docker stop <id>` calls the idle reaper made. */
const stopCalls = () => captureText.mock.calls.filter((c) => c[1][0] === "stop");

const fakeChild = (): EventEmitter => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {};
  return child;
};

beforeEach(() => {
  vi.useFakeTimers();
  captureText.mockReset();
  // Default: every docker exec succeeds; the pty probe reports no interactive session.
  captureText.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 });
  state.child = undefined;
});
afterEach(() => vi.useRealTimers());

describe("DockerExecutionContext idle reaping", () => {
  it("stops a genuinely idle container after the window and drops the handle", async () => {
    const ctx = make({ idleTimeoutMinutes: 1 });
    await ctx.stat("x"); // first IO provisions + arms the idle timer
    expect(ctx.isProvisioned()).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0]?.[1]).toEqual(["stop", "cid"]);
    // Handle dropped → the next IO re-provisions (restarting the stopped container).
    expect(ctx.isProvisioned()).toBe(false);
  });

  it("re-arms on later IO, so an active container isn't stopped early", async () => {
    const ctx = make({ idleTimeoutMinutes: 1 });
    await ctx.stat("x");
    await vi.advanceTimersByTimeAsync(40_000); // most of the window…
    await ctx.stat("y"); // …then IO resets it
    await vi.advanceTimersByTimeAsync(40_000); // 80s total, only 40s since the reset
    expect(stopCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20_000); // now 60s since the reset
    expect(stopCalls()).toHaveLength(1);
  });

  it("does not stop while an interactive session is attached; re-arms instead", async () => {
    const ctx = make({ idleTimeoutMinutes: 1 });
    await ctx.stat("x");

    captureText.mockResolvedValue({ stdout: "1", stderr: "", exitCode: 0 }); // a pty is present
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopCalls()).toHaveLength(0); // busy → re-armed, not reaped

    captureText.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 }); // session left
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopCalls()).toHaveLength(1);
  });

  it("does not stop while a spawned command is in flight; reaps after it ends", async () => {
    const ctx = make({ idleTimeoutMinutes: 1 });
    state.child = fakeChild();
    const proc = ctx.spawn("sleep 999");
    await vi.advanceTimersByTimeAsync(0); // let #ready resolve and nodeSpawn fire

    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopCalls()).toHaveLength(0); // in-flight → re-armed

    state.child.emit("close", 0, null); // command finishes
    await proc.exit;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopCalls()).toHaveLength(1);
  });

  it("disables idle reaping when idleTimeoutMinutes is 0", async () => {
    const ctx = make({ idleTimeoutMinutes: 0 });
    await ctx.stat("x");
    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour
    expect(stopCalls()).toHaveLength(0);
  });

  it("clears the idle timer on explicit stop()", async () => {
    const ctx = make({ idleTimeoutMinutes: 1 });
    await ctx.stat("x");
    expect(vi.getTimerCount()).toBe(1); // idle timer armed
    await ctx.stop();
    expect(vi.getTimerCount()).toBe(0); // ...and actually cleared, not just left to no-op on fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopCalls()).toHaveLength(0);
  });
});
