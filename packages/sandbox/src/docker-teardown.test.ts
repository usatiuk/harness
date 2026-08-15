import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the devcontainer layer so the test needs no docker daemon. `provisionDevcontainer` stays
// in-flight until its signal aborts (mirroring `spawn({ signal })`, which kills the child and rejects
// on abort); `stopSandbox` records when the reap runs so we can assert ordering.
const events = vi.hoisted(() => ({ log: [] as string[], aborted: false }));
vi.mock("./devcontainer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcontainer.ts")>()),
  provisionDevcontainer: (_root: string, opts: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => {
        events.aborted = true;
        events.log.push("provision-settled");
        reject(new Error("aborted"));
      });
    }),
  stopSandbox: async () => {
    events.log.push("stopSandbox");
    return 0;
  },
}));

const { DockerExecutionContext } = await import("./docker.ts");
const { dockerSandboxConfigSchema } = await import("./plugin.ts");
const config = dockerSandboxConfigSchema.parse({});

beforeEach(() => {
  events.log = [];
  events.aborted = false;
});

describe("DockerExecutionContext.stop (mid-provision teardown)", () => {
  it("aborts the in-flight provision and reaps only after it settles", async () => {
    const ctx = new DockerExecutionContext("/workspace", config);
    const io = ctx.read("x").catch(() => {}); // triggers provisioning; stays pending until aborted
    expect(ctx.isProvisioned()).toBe(true);

    await ctx.stop();

    expect(events.aborted).toBe(true);
    // The reap (stopSandbox) must run AFTER the provision settles — otherwise the label filter could
    // miss a container `up` was still creating, orphaning it.
    expect(events.log).toEqual(["provision-settled", "stopSandbox"]);
    expect(ctx.isProvisioned()).toBe(false);
    await io;
  });

  it("reaps by label even with nothing provisioned (idempotent, no spurious abort)", async () => {
    const ctx = new DockerExecutionContext("/workspace", config);
    await ctx.stop();
    expect(events.aborted).toBe(false);
    expect(events.log).toEqual(["stopSandbox"]);
  });

  it("cannot provision again after runtime disposal", async () => {
    const ctx = new DockerExecutionContext("/workspace", config);
    await ctx.dispose();

    await expect(ctx.rebuild()).rejects.toThrow("disposed");
    await expect(ctx.read("x")).rejects.toThrow("disposed");
    expect(events.log).toEqual(["stopSandbox"]);
  });

  it("does not let a concurrent rebuild revive a disposed runtime", async () => {
    const ctx = new DockerExecutionContext("/workspace", config);

    const rebuild = ctx.rebuild();
    await ctx.dispose();

    await expect(rebuild).rejects.toThrow("disposed");
    expect(ctx.isProvisioned()).toBe(false);
  });

  it("finishes cancellation cleanup before allowing provisioning to be reused", async () => {
    const ctx = new DockerExecutionContext("/workspace", config);
    const controller = new AbortController();
    const rebuild = ctx.rebuild(controller.signal);
    await vi.waitFor(() => expect(ctx.isProvisioned()).toBe(true));

    controller.abort();
    await expect(rebuild).rejects.toThrow("aborted");
    expect(events.log).toEqual(["stopSandbox", "provision-settled", "stopSandbox"]);
    expect(ctx.isProvisioned()).toBe(false);

    const reused = ctx.read("x").catch(() => {});
    expect(ctx.isProvisioned()).toBe(true);
    await ctx.stop();
    await reused;
  });
});
