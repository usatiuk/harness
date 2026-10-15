import { describe, expect, it, vi } from "vitest";
import type { ConfigReader, Conversation } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { sandboxPlugin } from "./plugin.ts";
import { sandboxConfigSchema } from "./config.ts";
import { DockerExecutionContext } from "./docker.ts";

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

  it("returns a Local substrate when local is selected or config is unset", () => {
    const local = executionFor(conv({ backend: "local" }));
    expect(local).toBeInstanceOf(LocalExecutionContext);
    expect((local as LocalExecutionContext).shellKind).toBe(
      process.platform === "win32" ? "powershell" : "bash",
    );
    expect(executionFor(conv())).toBeInstanceOf(LocalExecutionContext);
  });

  it("fills stable defaults for all backends", () => {
    expect(sandboxConfigSchema.parse({})).toEqual({
      backend: "local",
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
});
