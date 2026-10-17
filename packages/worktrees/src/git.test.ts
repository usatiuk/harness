import { InMemoryStore } from "@harness/store";
import { WorktreeManager } from "./manager.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceOperationError } from "@harness/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  allocateWorktree,
  addWorktree,
  gitDirectories,
  listWorktrees,
  removeWorktree,
  worktreeBranch,
} from "./git.ts";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: () => 0,
}));

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-worktrees-")));
  roots.push(root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  vi.stubEnv("GIT_DIR", undefined);
  vi.stubEnv("GIT_WORK_TREE", undefined);
  const git = (...args: string[]) =>
    execute("git", ["-C", root, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await git("init");
  await git("config", "user.name", "Harness Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "file.txt"), "committed\n");
  await git("add", "file.txt");
  await git("commit", "-m", "Initial");
  return { root, git };
}

it("creates independent checkouts from HEAD without copying dirty files and retains branches", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "file.txt"), "dirty\n");
  const tree = await createWorktree(root, join(root, "managed worktrees"));
  expect(await readFile(join(tree.path, "file.txt"), "utf8")).toBe("committed\n");
  expect((await listWorktrees(root)).map((entry) => entry.path)).toContain(tree.path);
  const dirs = await gitDirectories(tree.path);
  expect(dirs.common).not.toBe(dirs.private);
  await removeWorktree(root, tree.path, false);
  expect((await git("branch", "--list", tree.branch!)).stdout).toContain(tree.branch);
});

it("refuses dirty removal unless explicitly forced, and never removes the primary checkout", async () => {
  const { root } = await fixture();
  const tree = await createWorktree(root, join(root, "trees"));
  await writeFile(join(tree.path, "untracked"), "keep me");
  await expect(removeWorktree(root, tree.path, false)).rejects.toThrow();
  expect(await readFile(join(tree.path, "untracked"), "utf8")).toBe("keep me");
  await removeWorktree(root, tree.path, true);
  await expect(removeWorktree(root, root, true)).rejects.toThrow("primary checkout");
});

it("finishes an owned deletion after Git removal succeeded but persistence failed", async () => {
  const { root } = await fixture();
  const store = new InMemoryStore();
  const manager = new WorktreeManager(store, async () => join(root, "trees"));
  const tree = await manager.create(root);
  vi.spyOn(store, "deleteManagedWorktree").mockRejectedValueOnce(new Error("database unavailable"));
  await expect(manager.remove(tree.path, false)).rejects.toThrow("database unavailable");
  expect(await store.getManagedWorktree(tree.path)).toBeDefined();
  await manager.validateRemoval(tree.path, false);
  await manager.remove(tree.path, false);
  expect(await manager.managed(20)).toEqual([]);
});

async function createWorktree(cwd: string, directory: string) {
  const head = (await listWorktrees(cwd)).find((tree) => tree.path === cwd)!.head;
  return addWorktree(cwd, {
    ...(await allocateWorktree(directory, await worktreeBranch(cwd))),
    head,
  });
}

it("uses readable branch names, avoids unmounted branch collisions and keeps UUID checkout paths", async () => {
  const { root, git } = await fixture();
  await git("branch", "harness/bright-badger");
  await git("branch", "harness/bright-badger-2/nested");
  const manager = new WorktreeManager(new InMemoryStore(), async () => join(root, "trees"));
  const first = await manager.create(root);
  const second = await manager.create(root);
  expect(first.branch).toBe("harness/bright-badger-3");
  expect(second.branch).toBe("harness/bright-badger-4");
  expect(first.path).not.toBe(second.path);
  expect(first.path).toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}$/u);
  expect((await listWorktrees(root)).map((tree) => tree.branch)).toContain(first.branch);
});

it("creates an explicit branch and reads an external rename without changing checkout identity", async () => {
  const { root } = await fixture();
  const store = new InMemoryStore();
  const manager = new WorktreeManager(store, async () => join(root, "trees"));
  const tree = await manager.create(root, undefined, "feature/auth-refactor");
  expect(tree.branch).toBe("feature/auth-refactor");
  const owned = await store.getManagedWorktree(tree.path);
  await execute("git", ["-C", tree.path, "branch", "-m", "feature/renamed"]);
  expect(await manager.inspect(tree.path)).toMatchObject({
    path: tree.path,
    branch: "feature/renamed",
    head: tree.head,
  });
  expect(await store.getManagedWorktree(tree.path)).toEqual(owned);
});

it("orders worktrees by existing conversation use or managed creation time", async () => {
  const { root } = await fixture();
  const first = await createWorktree(root, join(root, "trees"));
  const second = await createWorktree(root, join(root, "trees"));
  const third = await createWorktree(root, join(root, "trees"));
  let now = 100;
  const store = new InMemoryStore(undefined, { now: () => now++ });
  const manager = new WorktreeManager(store, async () => join(root, "trees"));
  const a = await store.createConversation({ workspaceRoot: first.path, overrides: {} });
  await store.createConversation({ workspaceRoot: second.path, overrides: {} });
  await store.putManagedWorktree({ path: third.path, repository: root, createdAt: 105 });
  expect((await manager.list(root)).map((tree) => tree.path)).toEqual([
    third.path,
    second.path,
    first.path,
    root,
  ]);
  now = 110;
  store.recordUserInput(a.id);
  expect((await manager.list(root)).map((tree) => tree.path)).toEqual([
    first.path,
    third.path,
    second.path,
    root,
  ]);
});

it("creates distinct readable branches concurrently without reallocating checkout ownership", async () => {
  const { root } = await fixture();
  const store = new InMemoryStore();
  let selected = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new WorktreeManager(store, async () => {
    if (++selected === 2) release();
    await ready;
    return join(root, "trees");
  });
  const trees = await Promise.all([manager.create(root), manager.create(root)]);
  expect(trees.map((tree) => tree.branch).sort()).toEqual([
    "harness/bright-badger",
    "harness/bright-badger-2",
  ]);
  expect(new Set(trees.map((tree) => tree.path)).size).toBe(2);
  expect((await manager.managed(20)).map((tree) => tree.path).sort()).toEqual(
    trees.map((tree) => tree.path).sort(),
  );
});

it("does not substitute a different branch if an explicit name is claimed concurrently", async () => {
  const { root, git } = await fixture();
  const manager = new WorktreeManager(new InMemoryStore(), async () => {
    await git("branch", "requested");
    return join(root, "trees");
  });
  await expect(manager.create(root, undefined, "requested")).rejects.toThrow("conflicts");
  expect(await listWorktrees(root)).toHaveLength(1);
  expect(await manager.managed(20)).toHaveLength(1);
});

it("keeps the captured starting commit when a generated branch collision requires retry", async () => {
  const { root, git } = await fixture();
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const manager = new WorktreeManager(new InMemoryStore(), async () => {
    await git("branch", "harness/bright-badger");
    await writeFile(join(root, "file.txt"), "new source commit\n");
    await git("add", "file.txt");
    await git("commit", "-m", "Advance source");
    return join(root, "trees");
  });
  const tree = await manager.create(root);
  expect(tree.branch).toBe("harness/bright-badger-2");
  expect(tree.head).toBe(head);
  expect((await git("rev-parse", "HEAD")).stdout.trim()).not.toBe(head);
  expect(await readFile(join(tree.path, "file.txt"), "utf8")).toBe("committed\n");
});

it.each(["bad name", "-bad", "HEAD", "foo..bar", "@{-1}"])(
  "refuses invalid branch %s before recording ownership",
  async (branch) => {
    const { root } = await fixture();
    const manager = new WorktreeManager(new InMemoryStore(), async () => join(root, "trees"));
    await expect(manager.create(root, undefined, branch)).rejects.toBeInstanceOf(
      WorkspaceOperationError,
    );
    expect(await manager.managed(20)).toEqual([]);
    expect(await listWorktrees(root)).toHaveLength(1);
  },
);

it("refuses existing refs and namespace conflicts before recording ownership", async () => {
  const { root, git } = await fixture();
  await git("branch", "reserved");
  await git("branch", "feature/child");
  const manager = new WorktreeManager(new InMemoryStore(), async () => join(root, "trees"));
  for (const branch of ["reserved", "reserved/child", "feature"]) {
    await expect(manager.create(root, undefined, branch)).rejects.toThrow("conflicts");
  }
  await git("branch", "harness");
  await expect(manager.create(root)).rejects.toThrow("prevents generated");
  expect(await manager.managed(20)).toEqual([]);
});
it("records ownership before Git mutates and leaves failed creation explicitly removable", async () => {
  const { root } = await fixture();
  const store = new InMemoryStore();
  const manager = new WorktreeManager(store, async () => join(root, "trees"));
  // An unborn HEAD deterministically refuses creation after allocation.
  await execute("git", ["-C", root, "checkout", "--orphan", "unborn"]);
  await expect(manager.create(root)).rejects.toThrow();
  const rows = await manager.managed(20);
  expect(rows).toHaveLength(1);
  await manager.validateRemoval(rows[0]!.path, false);
  await manager.remove(rows[0]!.path, false);
  expect(await manager.managed(20)).toEqual([]);
});

it("requires force to clean files left in an owned but unregistered checkout", async () => {
  const { root } = await fixture();
  const store = new InMemoryStore();
  const manager = new WorktreeManager(store, async () => join(root, "trees"));
  const tree = await manager.create(root);
  await removeWorktree(root, tree.path, false);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(tree.path);
  await writeFile(join(tree.path, "remaining"), "partial checkout");
  await expect(manager.validateRemoval(tree.path, false)).rejects.toThrow("confirm force");
  await expect(manager.remove(tree.path, false)).rejects.toThrow("confirm force");
  await manager.validateRemoval(tree.path, true);
  await manager.remove(tree.path, true);
  expect(await manager.managed(20)).toEqual([]);
});
