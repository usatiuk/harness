import { unusedCodeEvaluator } from "@harness/testkit";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { InMemoryStore } from "@harness/store";
import { HarnessService } from "@harness/service";
import { WorktreeManager } from "@harness/worktrees";
import { createSandboxRuntime } from "./plugin.ts";
import { controlDockerWorkspace, dockerInventory } from "./docker-inventory.ts";
import { dockerTestEnvironment } from "./docker.test-support.ts";
import type { DockerExecutionContext } from "./docker.ts";
import { NativeExecutionContext } from "./native.ts";

const execute = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-linked-git-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  vi.stubEnv("GIT_DIR", undefined);
  vi.stubEnv("GIT_WORK_TREE", undefined);
  const repository = join(directory, "repository");
  await mkdir(join(repository, ".devcontainer"), { recursive: true });
  await writeFile(join(repository, "file"), "original");
  await writeFile(
    join(repository, ".devcontainer", "Dockerfile"),
    "FROM debian:stable-slim\nRUN apt-get update -qq && apt-get install -y -qq git procps && rm -rf /var/lib/apt/lists/*\n",
  );
  await writeFile(
    join(repository, ".devcontainer", "devcontainer.json"),
    JSON.stringify({
      build: { dockerfile: "Dockerfile" },
      remoteUser: "root",
      shutdownAction: "none",
    }),
  );
  const git = (...args: string[]) => execute("git", ["-C", repository, ...args]);
  await git("init");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Harness Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  );
  return { directory, repository };
}

async function command(execution: Pick<DockerExecutionContext, "spawn">, text: string) {
  const process = execution.spawn(text);
  let output = "";
  process.onData((chunk) => {
    output += chunk;
  });
  const result = await process.exit;
  if (result.code !== 0) throw new Error(`Command failed (${result.code}): ${output}`);
  return output.trim();
}

it
  .runIf(process.env.HARNESS_DOCKER_INTEGRATION === "1")
  .each(["host-paths", "translated-git-link"] as const)(
  "%s separates worktree environments, supports Git commits, retains state across stop/restart and removes on deletion",
  async (mapping) => {
    const { directory, repository } = await fixture();
    for (const [key, value] of Object.entries(
      await dockerTestEnvironment(join(directory, "docker-client")),
    ))
      vi.stubEnv(key, value);
    const platform = process.platform;
    // Exercise the translated .git mount using the real Linux Docker daemon too.
    // This establishes Git behavior; actual Docker Desktop path transport is a native Windows check.
    if (mapping === "translated-git-link")
      Object.defineProperty(process, "platform", { value: "win32" });
    const home = join(directory, "home");
    const store = new InMemoryStore();
    const worktrees = new WorktreeManager(store, async () => join(directory, "worktrees"));
    let runtime = createSandboxRuntime(home);
    let service = new HarnessService({
      codeEvaluator: unusedCodeEvaluator,
      home,
      store,
      worktrees,
      plugins: [runtime.plugin],
      removeWorkspaceEnvironment: (path) => runtime.environments.removeWorkspace(path),
      defaults: {
        model: { provider: "fake", model: "fake" },
        plugins: { sandbox: { backend: "docker" } },
      },
    });
    const conversations: string[] = [];
    try {
      const first = await service.createConversation({ cwd: repository });
      conversations.push(first.id);
      const { path: firstPath } = await service.selectWorkspace(first.id, { kind: "new" });
      const firstExecution = service.service(first.id, "execution") as DockerExecutionContext;
      await firstExecution.write("file", new TextEncoder().encode("worktree commit"));
      await command(
        firstExecution,
        "git add file && git -c user.name='Harness Test' -c user.email=test@example.invalid commit -m 'Worktree change'",
      );
      expect(await command(firstExecution, "git status --porcelain")).toBe("");
      const cwd = await command(firstExecution, "pwd");
      expect(
        await command(
          firstExecution,
          "git init -q nested && git -C nested rev-parse --show-toplevel",
        ),
      ).toBe(`${cwd}/nested`);
      await command(firstExecution, "rm -rf nested");
      expect(await readFile(join(repository, "file"), "utf8")).toBe("original");
      const output = await firstExecution.outputStore(first.id).put("test-output", "saved output");
      expect(new TextDecoder().decode(await firstExecution.read(output))).toBe("saved output");
      const shared = await service.createConversation({ cwd: firstPath });
      conversations.push(shared.id);
      await service.prepare(shared.id);
      expect((await service.getConversation(shared.id))?.originalWorkspaceRoot).toBe(repository);
      expect(await runtime.environments.inventory(20)).toHaveLength(1);
      const firstContainer = (await dockerInventory(runtime.environments.scope!))[0]!
        .containers[0]!;
      await command(firstExecution, "printf retained > /tmp/worktree-state");
      const { path: secondPath } = await service.selectWorkspace(first.id, { kind: "new" });
      expect(secondPath).not.toBe(firstPath);
      expect(await runtime.environments.inventory(20)).toHaveLength(2);
      expect((await runtime.environments.inventory(20)).every((row) => row.running)).toBe(true);
      for (const id of conversations) await service.deactivateSession(id as typeof first.id);
      expect((await runtime.environments.inventory(20)).every((row) => row.running)).toBe(true);
      await runtime.close();
      expect((await runtime.environments.inventory(20)).every((row) => !row.running)).toBe(true);

      runtime = createSandboxRuntime(home);
      service = new HarnessService({
        codeEvaluator: unusedCodeEvaluator,
        home,
        store,
        worktrees,
        plugins: [runtime.plugin],
        removeWorkspaceEnvironment: (path) => runtime.environments.removeWorkspace(path),
        defaults: {
          model: { provider: "fake", model: "fake" },
          plugins: { sandbox: { backend: "docker" } },
        },
      });
      await service.prepare(shared.id);
      const reopened = service.service(shared.id, "execution") as DockerExecutionContext;
      expect(await command(reopened, "cat /tmp/worktree-state")).toBe("retained");
      expect(
        (await dockerInventory(runtime.environments.scope!)).find(
          (row) => row.workspaceRoot === firstPath,
        )?.containers,
      ).toContain(firstContainer);
      await service.removeWorktree(firstPath, false);
      expect(
        (await dockerInventory(runtime.environments.scope!)).some(
          (row) => row.workspaceRoot === firstPath,
        ),
      ).toBe(false);
      await service.selectWorkspace(shared.id, { kind: "original" });
      expect((await service.getConversation(shared.id))?.workspaceRoot).toBe(repository);
    } finally {
      for (const id of conversations)
        await service.deactivateSession(id as import("@harness/protocol").ConversationId, {
          force: true,
        });
      await runtime.close();
      for (const row of await dockerInventory(runtime.environments.scope!))
        await controlDockerWorkspace(runtime.environments.scope!, row.id, "remove");
      await rm(directory, { recursive: true, force: true });
      Object.defineProperty(process, "platform", { value: platform });
      vi.unstubAllEnvs();
    }
  },
  240_000,
);

it.runIf(process.platform === "linux" && process.env.HARNESS_NATIVE_INTEGRATION === "1")(
  "allows Git commits in linked worktrees through native confinement",
  async () => {
    const { directory, repository } = await fixture();
    try {
      const manager = new WorktreeManager(new InMemoryStore(), async () =>
        join(directory, "worktrees"),
      );
      const tree = await manager.create(repository);
      const execution = new NativeExecutionContext(tree.path, {
        workspaceWrite: true,
        network: false,
      });
      await execution.prepare();
      await execution.write("file", new TextEncoder().encode("native change"));
      await command(
        execution,
        "git add file && git -c user.name='Harness Test' -c user.email=test@example.invalid commit -m 'Native change'",
      );
      expect(await command(execution, "git status --porcelain")).toBe("");
      expect(await readFile(join(repository, "file"), "utf8")).toBe("original");
    } finally {
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
