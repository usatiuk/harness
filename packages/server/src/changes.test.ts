import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, unusedCodeEvaluator } from "@harness/testkit";
import { WorktreeManager } from "@harness/worktrees";
import { DesktopSession } from "../../desktop/src/session.ts";
import { registerFeatureServer } from "./features.ts";

it("reads the selected server's current checkout through the public client and follows workspace switches", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-changes-rpc-")));
  const repository = join(root, "repository");
  await mkdir(repository);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repository, ...args]);
  const store = new InMemoryStore();
  const service = new HarnessService({
    store,
    home: join(root, "home"),
    codeEvaluator: unusedCodeEvaluator,
    plugins: [{ id: "fake", providers: () => [new FakeProvider([])] }],
    worktrees: new WorktreeManager(store, async () => join(root, "trees")),
  });
  const pair = createInProcessMessageConnectionPair();
  const host = new HarnessRpcHost(service);
  const server = new HarnessRpcSession({
    connection: pair.right,
    host,
    server: { name: "test", version: "1" },
  });
  const desktop = new DesktopSession(pair.left);
  registerFeatureServer(server);
  server.start();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repository, "file.txt"), "committed\n");
    await git("add", ".");
    await git("commit", "-m", "Initial");
    await desktop.start();
    const conversation = await desktop.client.create({
      cwd: repository,
      overrides: { model: { provider: "fake", model: "fake-1" } },
    });
    const view = await desktop.load(conversation.id);
    const id = view.conversation.id;
    await writeFile(join(repository, "file.txt"), "server checkout edit\n");
    const page = await desktop.plugins.listChanges(id, "uncommitted");
    expect(page.repository).toBe(repository);
    expect(page.files.map((file) => file.path)).toEqual(["file.txt"]);
    expect(
      (await desktop.plugins.readChangeDiff(id, "uncommitted", page.files[0]!)).patch,
    ).toContain("+server checkout edit");
    await expect(
      desktop.plugins.readChangeDiff(id, "uncommitted", {
        path: "../outside",
        previousPath: null,
        status: "M",
      }),
    ).rejects.toThrow("repository-relative");
    await desktop.plugins.switchWorkspace(id, { kind: "new" });
    const switched = await desktop.plugins.listChanges(id, "uncommitted");
    expect(switched.repository).not.toBe(repository);
    expect(switched.repository).toBe(view.conversation.workspaceRoot);
    expect(switched.files).toEqual([]);
    await expect(
      desktop.plugins.listChanges(id, "uncommitted", null, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await host.shutdown();
    await server.shutdown();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
