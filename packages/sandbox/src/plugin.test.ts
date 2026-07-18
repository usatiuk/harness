import { describe, expect, it } from "vitest";
import type { ConfigReader, Conversation } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { sandboxPlugin } from "./plugin.ts";
import { DockerExecutionContext } from "./docker.ts";

const readerStub: ConfigReader = { get: <C>() => Promise.resolve({} as C) };

const conv = (sandbox?: { enabled: boolean }): Conversation =>
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
  it("returns a Docker substrate when sandbox is enabled", () => {
    const execution = executionFor(conv({ enabled: true }));
    expect(execution).toBeInstanceOf(DockerExecutionContext);
    expect((execution as DockerExecutionContext).shellKind).toBe("bash");
  });

  it("returns a Local substrate when sandbox is disabled or unset", () => {
    const local = executionFor(conv({ enabled: false }));
    expect(local).toBeInstanceOf(LocalExecutionContext);
    expect((local as LocalExecutionContext).shellKind).toBe(
      process.platform === "win32" ? "powershell" : "bash",
    );
    expect(executionFor(conv())).toBeInstanceOf(LocalExecutionContext);
  });
});
