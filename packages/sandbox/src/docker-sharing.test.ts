import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent, ConversationId } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { HarnessService } from "@harness/service";
import type { DockerExecutionContext } from "./docker.ts";

const state = vi.hoisted(() => ({
  provision: vi.fn<typeof import("./devcontainer.ts").provisionDevcontainer>(),
  stop: vi.fn(),
  capture: vi.fn<typeof import("./docker-cli.ts").capture>(),
  captureText: vi.fn<typeof import("./docker-cli.ts").captureText>(),
  children: [] as Array<{ child: ChildProcess; containerId: string; command: string }>,
  project: "",
  nextId: 0,
}));

vi.mock("./devcontainer.ts", async (original) => ({
  ...(await original<typeof import("./devcontainer.ts")>()),
  containerRoot: async () => state.project,
  provisionDevcontainer: (root: string, options: import("./devcontainer.ts").ProvisionOptions) => {
    options.onStarted?.();
    return state.provision(root, options);
  },
  stopSandbox: state.stop,
}));
vi.mock("./docker-cli.ts", () => ({ capture: state.capture, captureText: state.captureText }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (_bin: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const command = args.at(-1)!;
    const containerId = args[args.indexOf("bash") - 1]!;
    state.children.push({ child, containerId, command });
    return child;
  },
}));

const { sandboxPlugin } = await import("./plugin.ts");
const { isSandboxStatus } = await import("./devcontainer.ts");

const finish = (child: ChildProcess, code: number | null = 0, signal: string | null = null) => {
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
};
const handle = () => ({
  containerId: `container-${++state.nextId}`,
  remoteUser: "root",
  remoteWorkspaceFolder: "/workspaces/project",
});
const makeService = (idleTimeoutMinutes = 0) =>
  new HarnessService({
    store: new InMemoryStore(),
    home: "/nonexistent-harness-home",
    defaults: {
      model: { provider: "fake", model: "fake" },
      plugins: { sandbox: { backend: "docker", docker: { idleTimeoutMinutes } } },
    },
    plugins: [sandboxPlugin],
  });
async function attach(service: HarnessService, cwd = state.project, overrides = {}) {
  const conversation = await service.createConversation({ cwd, overrides });
  await service.prepare(conversation.id);
  return {
    id: conversation.id,
    execution: service.service(conversation.id, "execution") as DockerExecutionContext,
  };
}

beforeEach(() => {
  state.project = resolve("D:/audit-shared-project");
  state.children = [];
  state.nextId = 0;
  state.provision.mockReset().mockImplementation(async () => handle());
  state.stop.mockReset().mockImplementation(async () => {
    for (const { child } of state.children) finish(child, 137);
    return 1;
  });
  state.capture.mockReset().mockImplementation(async (_bin, args: string[]) => ({
    stdout: Buffer.from(args.at(-1)!),
    stderr: "",
    exitCode: 0,
  }));
  state.captureText.mockReset().mockImplementation(async (_bin, args: string[]) => {
    const script = args.at(-1)!;
    if (script.includes("pgrep")) {
      for (const entry of state.children) {
        if (script.includes(entry.command.split("# ").at(-1)!))
          finish(entry.child, null, "SIGTERM");
      }
    }
    return { stdout: "0", stderr: "", exitCode: 0 };
  });
});
afterEach(() => vi.useRealTimers());

describe("shared Docker conversation ownership", () => {
  it("uses the longest owner timeout and updates it after release", async () => {
    vi.useFakeTimers();
    const service = makeService(1),
      a = await attach(service),
      b = await attach(service, state.project, {
        plugins: { sandbox: { docker: { idleTimeoutMinutes: 2 } } },
      });
    await a.execution.read("file");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.captureText.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
    await service.deactivateSession(b.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.captureText.mock.calls.filter(([, args]) => args[0] === "stop")).toHaveLength(1);
    await service.deactivateSession(a.id);
  });

  it("disables shared idle stopping while any owner disables its timeout", async () => {
    vi.useFakeTimers();
    const service = makeService(1),
      a = await attach(service),
      b = await attach(service, state.project, {
        plugins: { sandbox: { docker: { idleTimeoutMinutes: 0 } } },
      });
    await a.execution.read("file");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(state.captureText.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
    await service.deactivateSession(b.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.captureText.mock.calls.filter(([, args]) => args[0] === "stop")).toHaveLength(1);
    await service.deactivateSession(a.id);
  });

  it("cancels and awaits A's file-operation client while B retains the environment", async () => {
    const service = makeService(),
      a = await attach(service),
      b = await attach(service);
    await b.execution.read("file");
    let aborted = false,
      finishClient!: () => void;
    state.captureText.mockImplementationOnce(
      (_bin, _args, options) =>
        new Promise((_resolve, reject) => {
          finishClient = () => reject(new Error("client aborted"));
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    );
    const io = a.execution.stat("slow");
    const rejected = expect(io).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(finishClient).toBeTypeOf("function"));
    let closed = false;
    const closing = service.deactivateSession(a.id).then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(closed).toBe(false);
    expect(state.stop).not.toHaveBeenCalled();
    finishClient();
    await Promise.all([closing, rejected]);
    expect(b.execution.isProvisioned()).toBe(true);
    await service.deactivateSession(b.id);
  });
  it("closing an unused A preserves B's running command; last release cleans the environment", async () => {
    const service = makeService(),
      a = await attach(service),
      b = await attach(service);
    const process = b.execution.spawn("B command");
    await vi.waitFor(() => expect(state.children).toHaveLength(1));
    let exited = false;
    void process.exit.then(() => {
      exited = true;
    });
    await service.deactivateSession(a.id);
    expect(state.stop).not.toHaveBeenCalled();
    expect(exited).toBe(false);
    expect(b.execution.isProvisioned()).toBe(true);
    expect(new TextDecoder().decode(await b.execution.read("file"))).toBe(
      "/workspaces/project/file",
    );
    await service.deactivateSession(b.id);
    await expect(process.exit).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  it("closing A detaches its provisioning wait without aborting B's shared build", async () => {
    let release!: () => void, signal!: AbortSignal;
    const building = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    state.provision.mockImplementation(async (_root, options) => {
      signal = options.signal!;
      await building;
      return handle();
    });
    const service = makeService(),
      a = await attach(service),
      b = await attach(service);
    const readA = a.execution.read("A");
    const rejectedA = expect(readA).rejects.toThrow("cancelled");
    const readB = b.execution.read("B");
    await vi.waitFor(() => expect(state.provision).toHaveBeenCalledTimes(1));
    await service.deactivateSession(a.id);
    await rejectedA;
    expect(signal.aborted).toBe(false);
    expect(state.stop).not.toHaveBeenCalled();
    release();
    expect(new TextDecoder().decode(await readB)).toBe("/workspaces/project/B");
    await service.deactivateSession(b.id);
  });

  it("cancels a pending command immediately while another conversation awaits the same build", async () => {
    let release!: () => void;
    const building = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    state.provision.mockImplementation(async () => {
      await building;
      return handle();
    });
    const service = makeService(),
      a = await attach(service),
      b = await attach(service);
    const processA = a.execution.spawn("A"),
      processB = b.execution.spawn("B");
    await vi.waitFor(() => expect(state.provision).toHaveBeenCalledTimes(1));
    processA.kill();
    await expect(processA.exit).resolves.toMatchObject({ signal: "SIGTERM" });
    await service.deactivateSession(a.id);
    release();
    await vi.waitFor(() => expect(state.children).toHaveLength(1));
    expect(state.children[0]?.command).toContain("B");
    finish(state.children[0]!.child);
    await processB.exit;
    await service.deactivateSession(b.id);
  });

  it("warns both conversations, performs shared stop/rebuild, and updates both handles", async () => {
    const service = makeService(),
      a = await attach(service),
      b = await attach(service);
    const warnings: Array<{ id: ConversationId; event: PluginEvent }> = [];
    service.subscribe((event) => {
      if (isSandboxStatus(event) && event.phase === "warning")
        warnings.push({ id: event.conversationId as ConversationId, event });
    });
    await Promise.all([a.execution.read("a"), b.execution.read("b")]);
    expect(state.provision).toHaveBeenCalledTimes(1);
    await a.execution.stop();
    expect(a.execution.isProvisioned()).toBe(false);
    expect(b.execution.isProvisioned()).toBe(false);
    expect(warnings.map(({ id }) => id)).toEqual([a.id, b.id]);
    expect(warnings.every(({ event }) => String(event.message).includes("2 conversations"))).toBe(
      true,
    );
    await b.execution.rebuild();
    expect(a.execution.isProvisioned()).toBe(true);
    expect(b.execution.isProvisioned()).toBe(true);
    expect(warnings).toHaveLength(4);
    await service.deactivateSession(a.id);
    await service.deactivateSession(b.id);
  });

  it("keeps different recipes independent and maps a subdirectory within a shared project", async () => {
    const service = makeService(),
      a = await attach(service),
      b = await attach(service, resolve(state.project, "subdir"));
    const other = await attach(service, state.project, {
      plugins: { sandbox: { docker: { configPath: ".devcontainer/other.json" } } },
    });
    expect(new TextDecoder().decode(await b.execution.read("file"))).toBe(
      "/workspaces/project/subdir/file",
    );
    await a.execution.read("root");
    await other.execution.read("other");
    expect(state.provision).toHaveBeenCalledTimes(2);
    await other.execution.stop();
    expect(a.execution.isProvisioned()).toBe(true);
    expect(other.execution.isProvisioned()).toBe(false);
    await Promise.all([
      service.deactivateSession(a.id),
      service.deactivateSession(b.id),
      service.deactivateSession(other.id),
    ]);
  });

  it("counts B's command when A is idle, then idle-stops the shared handle after completion", async () => {
    vi.useFakeTimers();
    const service = makeService(1),
      a = await attach(service),
      b = await attach(service);
    await a.execution.read("file");
    const process = b.execution.spawn("long command");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.captureText.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
    finish(state.children[0]!.child);
    await process.exit;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.captureText.mock.calls.filter(([, args]) => args[0] === "stop")).toHaveLength(1);
    expect(a.execution.isProvisioned()).toBe(false);
    expect(b.execution.isProvisioned()).toBe(false);
    await Promise.all([service.deactivateSession(a.id), service.deactivateSession(b.id)]);
  });
});
