import { describe, expect, it, vi } from "vitest";
import type { ConfigReader, Conversation } from "@harness/protocol";
import { selectUserShell, LocalExecutionContext } from "@harness/execution";
import { createSandboxRuntime, sandboxPlugin } from "./plugin.ts";
import { sandboxConfigSchema } from "./config.ts";
import { DockerExecutionContext } from "./docker.ts";
import { NativeExecutionContext } from "./native.ts";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@microsoft/mxc-sdk/v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@microsoft/mxc-sdk/v1")>()),
  getAvailableBackends: () => {
    probe();
    return [{ backend: "processcontainer" }];
  },
  getPlatformSupport: () => {
    probe();
    return { availableMethods: ["bubblewrap", "seatbelt"] };
  },
  run: async () => ({ exitCode: 0, timedOut: false }),
}));

const readerStub: ConfigReader = { get: <C>() => Promise.resolve({} as C) };

const conv = (sandbox?: Record<string, unknown>): Conversation =>
  ({
    id: "c1",
    workspaceRoot: "/w",
    overrides: {},
    head: null,
    createdAt: 0,
    config: {
      instructions: "",
      model: { provider: "p", model: "m" },
      plugins: sandbox ? { sandbox } : {},
    },
  }) as unknown as Conversation;

const executionFor = (c: Conversation): unknown => {
  const plugin = sandboxPlugin.create(readerStub);
  return plugin.services!()[0]!.for(c);
};

describe("sandboxPlugin execution provider", () => {
  it("returns a Docker substrate when Docker is selected", () => {
    const execution = executionFor(conv({ backend: "docker" }));
    expect(execution).toBeInstanceOf(DockerExecutionContext);
    expect((execution as DockerExecutionContext).shellKind).toBe("bash");
  });

  it("returns an unconfined substrate when none is selected or config is unset", () => {
    const local = executionFor(conv({ backend: "none" }));
    expect(local).toBeInstanceOf(LocalExecutionContext);
    expect((local as LocalExecutionContext).shellKind).toBe(
      process.platform === "win32" ? "powershell" : selectUserShell().kind,
    );
    expect(executionFor(conv())).toBeInstanceOf(LocalExecutionContext);
  });

  it("accepts the saved local name and resolves only the canonical none value", () => {
    expect(sandboxConfigSchema.parse({ backend: "local" }).backend).toBe("none");
    expect(executionFor(conv({ backend: "local" }))).toBeInstanceOf(LocalExecutionContext);
  });

  it("fills stable defaults for all backends", () => {
    expect(sandboxConfigSchema.parse({})).toEqual({
      backend: "none",
      native: { workspaceWrite: true, network: true },
      docker: {
        configPath: ".devcontainer/devcontainer.json",
      },
    });
  });

  it("removes a Docker substrate when its runtime is disposed", async () => {
    const provider = sandboxPlugin.create(readerStub).services!()[0]!;
    const execution = provider.for(conv({ backend: "docker" })) as DockerExecutionContext;
    const dispose = vi.spyOn(execution, "dispose").mockResolvedValue();

    await provider.dispose!(execution);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("probes native capability once per server across conversation activations", async () => {
    probe.mockClear();
    const runtime = await createSandboxRuntime(process.cwd());
    try {
      expect(runtime.defaultBackend).toBe("native");
      const provider = runtime.plugin.create(readerStub).services!()[0]!;
      const conversation = { ...conv({ backend: "native" }), workspaceRoot: null };
      const first = provider.for(conversation) as NativeExecutionContext;
      const second = provider.for(conversation) as NativeExecutionContext;
      await first.prepare();
      await second.prepare();
      await first.prepare();
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });
});
