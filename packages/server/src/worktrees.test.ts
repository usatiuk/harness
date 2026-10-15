import { sandboxWorkspaceRequest } from "@harness/sandbox";
import { dockerTestEnvironment } from "../../sandbox/src/docker.test-support.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { MemorySecretStore } from "@harness/secrets";
import { appSettingsRequest, appSettingsUpdateRequest } from "./client-protocol.ts";
import {
  worktreeCreateConversationRequest,
  worktreeManagedRequest,
  worktreeOptionsRequest,
  worktreeRemoveRequest,
  worktreeRepositoryRequest,
  worktreeSwitchRequest,
} from "@harness/worktrees/client";
import { buildServerHarness } from "./index.ts";
import * as credentials from "./credential-store.ts";

it("persists worktree settings, selection, configuration origin, fork metadata and management through real RPC and SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-worktree-rpc-"));
  const home = join(directory, "home");
  const repository = join(directory, "repository");
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ])
    vi.stubEnv(name, "");
  const secrets = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store: secrets, kind: null });
  vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({
    store: secrets,
    kind: "file",
  });
  await mkdir(join(repository, ".harness"), { recursive: true });
  await writeFile(join(repository, "file"), "original");
  await writeFile(join(repository, ".harness", ".gitignore"), "*\n");
  await writeFile(
    join(repository, ".harness", "settings.local.json"),
    JSON.stringify({ version: 1, instructions: "ORIGINAL PROJECT SETTINGS" }),
  );
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repository, ...args]);
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
  const connect = async () => {
    const pair = createInProcessMessageConnectionPair();
    const harness = await buildServerHarness(pair.right);
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "worktrees-test", version: "1" },
    });
    await client.start();
    return { harness, client };
  };
  let current = await connect();
  try {
    expect(await current.harness.service.worktreeRepository(directory)).toBeNull();
    expect(
      await current.client.peer.request(worktreeRepositoryRequest, { path: directory }),
    ).toBeNull();
    expect(await current.client.peer.request(worktreeRepositoryRequest, { path: repository })).toBe(
      repository,
    );
    const storage = join(directory, "custom worktrees");
    await current.client.peer.request(appSettingsUpdateRequest, { worktreeDirectory: storage });
    await expect(
      current.client.peer.request(appSettingsUpdateRequest, { worktreeDirectory: "relative/path" }),
    ).rejects.toThrow("absolute");
    const conversation = await current.client.peer.request(worktreeCreateConversationRequest, {
      cwd: repository,
      overrides: {},
    });
    expect(dirname(conversation.workspaceRoot!)).toBe(storage);
    expect(conversation.originalWorkspaceRoot).toBe(repository);
    expect(conversation.config.instructions).toBe("ORIGINAL PROJECT SETTINGS");
    const firstPath = conversation.workspaceRoot!;
    await current.client.attach(conversation.id);
    const turn = await current.harness.store.createTurn(
      conversation.id as import("@harness/protocol").ConversationId,
    );
    const user = await current.harness.store.appendItem({
      conversationId: turn.conversationId,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "original message" }],
    });
    await current.harness.store.updateTurn(turn.id, "completed");
    const fork = await current.client.forkBefore(conversation.id, user.id);
    expect(fork.conversation.originalWorkspaceRoot).toBe(repository);
    expect(fork.conversation.workspaceRoot).toBe(firstPath);
    const alias = join(directory, "linked checkout alias");
    await symlink(firstPath, alias, process.platform === "win32" ? "junction" : "dir");
    const linkedConversation = await current.client.create({ cwd: alias, overrides: {} });
    expect(linkedConversation.workspaceRoot).toBe(firstPath);
    expect(linkedConversation.originalWorkspaceRoot).toBe(repository);
    expect(linkedConversation.config.instructions).toBe("ORIGINAL PROJECT SETTINGS");
    if (process.env.HARNESS_DOCKER_INTEGRATION === "1") {
      for (const [key, value] of Object.entries(
        await dockerTestEnvironment(join(directory, "docker-client")),
      ))
        vi.stubEnv(key, value);
      const recipe = join(repository, ".harness", "devcontainer.json");
      await writeFile(recipe, JSON.stringify({ image: "node:24.21.0-alpine", remoteUser: "root" }));
      await writeFile(
        join(repository, ".harness", "settings.local.json"),
        JSON.stringify({
          version: 1,
          instructions: "ORIGINAL PROJECT SETTINGS",
          plugins: { sandbox: { docker: { configPath: recipe } } },
        }),
      );

      const handle = await current.client.peer.request(sandboxWorkspaceRequest, {
        path: alias,
        action: "start",
      });
      expect(handle?.containerId).toBeTruthy();
      await current.client.peer.request(sandboxWorkspaceRequest, { path: alias, action: "stop" });
      const state = await promisify(execFile)("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        handle!.containerId,
      ]);
      expect(state.stdout.trim()).toBe("false");
    }
    await current.client.peer.request(appSettingsUpdateRequest, { worktreeDirectory: null });
    expect(
      (await current.client.peer.request(appSettingsRequest, {})).settings.worktreeDirectory,
    ).toBeNull();
    current.client.closeConnection();
    await current.harness.close();
    current = await connect();
    const resumed = await current.client.get(conversation.id);
    expect(resumed).toMatchObject({
      workspaceRoot: firstPath,
      originalWorkspaceRoot: repository,
      config: { instructions: "ORIGINAL PROJECT SETTINGS" },
    });
    expect(
      (await current.client.peer.request(worktreeManagedRequest, { limit: 1, before: null }))[0]
        ?.path,
    ).toBe(firstPath);
    const options = await current.client.peer.request(worktreeOptionsRequest, {
      conversationId: conversation.id,
    });
    expect(options!.worktrees.map((tree) => tree.path)).toContain(firstPath);
    await current.client.peer.request(worktreeSwitchRequest, {
      conversationId: conversation.id,
      selection: { kind: "original" },
    });
    expect((await current.client.get(conversation.id))?.workspaceRoot).toBe(repository);
    await writeFile(join(firstPath, "untracked"), "discard only after explicit confirmation");
    await expect(
      current.client.peer.request(worktreeRemoveRequest, { path: firstPath, force: false }),
    ).rejects.toThrow("uncommitted or untracked");
    expect(await readFile(join(firstPath, "untracked"), "utf8")).toContain("confirmation");
    await current.client.peer.request(worktreeRemoveRequest, { path: firstPath, force: true });
    expect(
      await current.client.peer.request(worktreeManagedRequest, { limit: 20, before: null }),
    ).toEqual([]);
    expect((await current.client.get(conversation.id))?.head).toBe(user.id);
    expect((await git("branch", "--list", "harness/*")).stdout).toContain("harness/");
    // The fork still points at the removed checkout, but can recover without preparing it.
    await current.client.peer.request(worktreeSwitchRequest, {
      conversationId: fork.conversation.id,
      selection: { kind: "original" },
    });
    expect((await current.client.get(fork.conversation.id))?.workspaceRoot).toBe(repository);
  } finally {
    current.client.closeConnection();
    await current.harness.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}, 20_000);
