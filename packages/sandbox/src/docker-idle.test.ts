import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  provision: vi.fn(),
  stop: vi.fn(),
  remove: vi.fn(),
  handle: { containerId: "retained", remoteUser: "root", remoteWorkspaceFolder: "/work" },
}));
vi.mock("./devcontainer.ts", async (original) => ({
  ...(await original<typeof import("./devcontainer.ts")>()),
  containerRoot: async (path: string) => path,
  provisionDevcontainer: state.provision,
  stopSandbox: state.stop,
  removeSandbox: state.remove,
}));
vi.mock("./docker-cli.ts", () => ({
  captureText: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  capture: async () => ({ stdout: Buffer.from("file"), stderr: "", exitCode: 0 }),
}));
const { DockerExecutionContext } = await import("./docker.ts");
const { DockerEnvironmentPool } = await import("./docker-environment.ts");
const { dockerSandboxConfigSchema } = await import("./config.ts");
beforeEach(() => {
  vi.useFakeTimers();
  state.provision.mockReset().mockResolvedValue(state.handle);
  state.stop.mockReset().mockResolvedValue(1);
  state.remove.mockReset().mockResolvedValue(1);
});
afterEach(() => vi.useRealTimers());

it("retains environments after idle time and last view release; server close stops without removal", async () => {
  const pool = new DockerEnvironmentPool();
  const context = new DockerExecutionContext(
    "/work",
    dockerSandboxConfigSchema.parse({ idleTimeoutMinutes: 1 }),
    pool,
  );
  await context.prepare();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  await context.dispose();
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
  await pool.close();
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.remove).not.toHaveBeenCalled();
});

it("keeps explicit Stop stopped until reopen, then reuses provisioning; Remove is separate", async () => {
  const pool = new DockerEnvironmentPool();
  const context = new DockerExecutionContext("/work", dockerSandboxConfigSchema.parse({}), pool);
  await context.prepare();
  await context.stop();
  await expect(context.read("file")).rejects.toThrow("is stopped");
  expect(state.provision).toHaveBeenCalledTimes(1);
  await context.prepare();
  expect(new TextDecoder().decode(await context.read("file"))).toBe("file");
  expect(state.provision).toHaveBeenCalledTimes(2);
  await pool.list()[0]!.remove();
  expect(state.remove).toHaveBeenCalledOnce();
  await expect(context.read("file")).rejects.toThrow("was removed");
  await context.prepare();
  expect(state.provision).toHaveBeenCalledTimes(3);
  await context.dispose();
});

it("keeps separate environments for roots sharing an absolute recipe", async () => {
  const pool = new DockerEnvironmentPool();
  const config = dockerSandboxConfigSchema.parse({ configPath: "/shared/devcontainer.json" });
  const first = new DockerExecutionContext("/first", config, pool);
  const second = new DockerExecutionContext("/second", config, pool);
  await first.prepare();
  await second.prepare();
  expect(pool.list().map((environment) => environment.root)).toEqual(["/first", "/second"]);
  await first.stop();
  await expect(first.read("file")).rejects.toThrow("stopped");
  await expect(second.read("file")).resolves.toBeDefined();
  await first.dispose();
  await second.dispose();
  await pool.close();
});

it.each(["stop", "remove"] as const)(
  "serializes a concurrent open before later %s",
  async (action) => {
    const pool = new DockerEnvironmentPool();
    const owner = { emit: () => {} };
    const environment = await pool.acquire("/work", dockerSandboxConfigSchema.parse({}), owner);
    const opening = environment.start();
    const rejected = expect(opening).rejects.toThrow("cancelled");
    await environment[action]();
    await rejected;
    await expect(environment.ready()).rejects.toThrow(action === "stop" ? "stopped" : "removed");
    expect(state.provision).not.toHaveBeenCalled();
    await environment.release(owner);
  },
);
it("rejects late acquisitions and stale views after terminal server close", async () => {
  const pool = new DockerEnvironmentPool();
  const owner = { emit: () => {} };
  const acquiring = pool.acquire("/work", dockerSandboxConfigSchema.parse({}), owner);
  await pool.close();
  await expect(acquiring).rejects.toThrow("closing");
  expect(pool.list()).toHaveLength(0);
  const another = new DockerEnvironmentPool();
  const environment = await another.acquire("/work", dockerSandboxConfigSchema.parse({}), owner);
  await environment.start();
  await another.close();
  await expect(environment.start()).rejects.toThrow("closed");
  await expect(environment.rebuild()).rejects.toThrow("closed");
  await environment.release(owner);
});

it("does not skip a later Stop after Remove and a queued reopen", async () => {
  const pool = new DockerEnvironmentPool();
  const owner = { emit: () => {} };
  const environment = await pool.acquire("/work", dockerSandboxConfigSchema.parse({}), owner);
  await environment.remove();
  const opening = environment.start();
  const rejected = expect(opening).rejects.toThrow("cancelled");
  await environment.stop();
  await rejected;
  expect(state.provision).not.toHaveBeenCalled();
  await expect(environment.ready()).rejects.toThrow("removed");
  await environment.release(owner);
});
