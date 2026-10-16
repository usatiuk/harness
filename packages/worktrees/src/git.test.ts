import { InMemoryStore } from "@harness/store";
import { WorktreeManager } from "./manager.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import {
  allocateWorktree,
  addWorktree,
  gitDirectories,
  listWorktrees,
  removeWorktree,
} from "./git.ts";

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
  return addWorktree(cwd, await allocateWorktree(directory));
}
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
