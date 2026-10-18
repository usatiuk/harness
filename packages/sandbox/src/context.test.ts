import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf, type ModelProvider, type ModelRequest } from "@harness/protocol";
import { LocalExecutionContext } from "@harness/execution";
import { HarnessService } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, textStep, unusedCodeEvaluator } from "@harness/testkit";

const state = vi.hoisted(() => ({ root: "", exitCode: 0, exec: [] as string[] }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: () => ({ status: 0, stderr: "", stdout: "" }),
}));
vi.mock("./devcontainer.ts", async (original) => ({
  ...(await original<typeof import("./devcontainer.ts")>()),
  containerRoot: async () => state.root,
  provisionDevcontainer: async () => ({
    containerId: "container",
    remoteUser: "developer",
    remoteWorkspaceFolder: "/workspaces/project",
  }),
}));
vi.mock("./docker-cli.ts", () => ({
  captureText: async (_bin: string, args: string[]) => {
    state.exec = args;
    return { stdout: "", stderr: "", exitCode: state.exitCode };
  },
}));
const { sandboxPlugin } = await import("./plugin.ts");
const { NativeExecutionContext } = await import("./native.ts");
const { DockerExecutionContext } = await import("./docker.ts");
const plugin = sandboxPlugin.create({ get: async <C>() => ({}) as C });
const source = plugin.contextSources!()[0]!;
const instructions = async (execution: unknown) =>
  textOf(
    await source.instructions({
      service: () => execution,
      toolNames: [],
    }),
  );
const roots: string[] = [];
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-sandbox-context-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("active sandbox instructions", () => {
  it("omits sandbox context for an unconfined execution service", async () => {
    expect(await instructions(new LocalExecutionContext(null))).toBe("");
  });

  it.skipIf(process.platform !== "linux")(
    "uses active native permissions and temporary lifetime",
    async () => {
      const root = await workspace();
      const text = await instructions(
        new NativeExecutionContext(root, { workspaceWrite: false, network: false }),
      );
      expect(text).toContain(`Workspace: ${root} (read-only)`);
      expect(text).toContain("network access: disabled");
      expect(text).toContain("outside writable mounts are read-only");
      expect(text).toContain("shared across commands and workspaces");
      expect(text).toContain("Server restart selects a fresh directory");
      expect(text).toContain("documented escalation mechanism");
      expect(text).not.toContain("sandbox_permissions");
    },
  );

  it.each([0, 1])(
    "reports mapped Docker workspace and actual access (exit %s)",
    async (exitCode) => {
      state.root = await workspace();
      await mkdir(join(state.root, "subdir"));
      state.exitCode = exitCode;
      const execution = new DockerExecutionContext(join(state.root, "subdir"), {
        configPath: ".devcontainer/devcontainer.json",
      });
      try {
        const text = await instructions(execution);
        expect(state.exec).toEqual([
          "exec",
          "-u",
          "developer",
          "container",
          "test",
          "-w",
          "/workspaces/project/subdir",
        ]);
        expect(text).toContain(
          `/workspaces/project/subdir (${exitCode === 0 ? "writable" : "not writable"}`,
        );
        expect(text).toContain("Host escape is unavailable");
        expect(text).toContain("filesystem and mount configuration");
      } finally {
        await execution.dispose();
      }
    },
  );

  it("surfaces a failed Docker access probe instead of claiming a read-only workspace", async () => {
    state.root = await workspace();
    state.exitCode = 2;
    const execution = new DockerExecutionContext(state.root, {
      configPath: ".devcontainer/devcontainer.json",
    });
    try {
      await expect(instructions(execution)).rejects.toThrow("check workspace access failed");
    } finally {
      await execution.dispose();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "includes active sandbox context in the actual model request",
    async () => {
      const root = await workspace();
      const fake = new FakeProvider([textStep("done")]);
      const stream = fake.stream.bind(fake);
      const requests: ModelRequest[] = [];
      const provider: ModelProvider = Object.assign(fake, {
        stream(request: ModelRequest) {
          requests.push(request);
          return stream();
        },
      });
      const service = new HarnessService({
        codeEvaluator: unusedCodeEvaluator,
        store: new InMemoryStore(),
        home: join(root, "home"),
        plugins: [sandboxPlugin, { id: "fake", providers: () => [provider] }],
      });
      const conversation = await service.createConversation({
        cwd: root,
        overrides: {
          model: { provider: "fake", model: "fake" },
          plugins: {
            sandbox: { backend: "native", native: { workspaceWrite: true, network: true } },
          },
        },
      });
      try {
        await service.send(conversation.id, "go");
        await service.whenIdle(conversation.id);
        expect(requests).toHaveLength(1);
        expect(textOf(requests[0]!.instructions)).toContain(`Workspace: ${root} (writable)`);
        expect(textOf(requests[0]!.instructions)).toContain("network access: enabled");
      } finally {
        await service.deactivateSession(conversation.id, { force: true });
      }
    },
  );
});
