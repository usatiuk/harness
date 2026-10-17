import { WorkspaceOperationError } from "@harness/protocol";
import type { Store, WorktreeInfo, WorktreeOperations } from "@harness/protocol";
import { realpath, stat, rm } from "node:fs/promises";
import {
  findRepository,
  allocateWorktree,
  addWorktree,
  listWorktrees,
  removeWorktree,
  repositoryRoot,
  validateWorktreeRemoval,
  worktreeBranch,
  WorktreeBranchExistsError,
} from "./git.ts";

/** Only ownership is persisted; Git supplies current branch/checkout facts. */
export class WorktreeManager implements WorktreeOperations {
  constructor(
    private readonly store: Store,
    private readonly directory: () => Promise<string>,
  ) {}

  repository(path: string): Promise<string | null> {
    return findRepository(path);
  }

  list(repository: string): Promise<WorktreeInfo[]> {
    return listWorktrees(repository);
  }

  async inspect(path: string): Promise<WorktreeInfo> {
    const root = await repositoryRoot(path);
    const tree = (await listWorktrees(root)).find((entry) => entry.path === root);
    if (!tree) throw new Error("Directory is not a registered Git checkout");
    return tree;
  }

  async create(repository: string, signal?: AbortSignal, branch?: string): Promise<WorktreeInfo> {
    const root = await repositoryRoot(repository);
    const checkouts = await listWorktrees(root);
    const original = checkouts[0];
    if (!original) throw new Error("Git repository has no checkouts");
    const source = checkouts.find((tree) => tree.path === root);
    if (!source) throw new Error("Source checkout is missing from Git metadata");
    const name = await worktreeBranch(root, branch, signal);
    const target = { ...(await allocateWorktree(await this.directory(), name)), head: source.head };
    signal?.throwIfAborted();
    // Record ownership before Git can create files, including a cancelled/failed checkout.
    // Its managed entry remains removable if Git succeeds but response delivery fails.
    await this.store.putManagedWorktree({
      path: target.path,
      repository: original.path,
      createdAt: Date.now(),
    });
    let collisions = 0;
    for (;;) {
      try {
        return await addWorktree(root, target, signal);
      } catch (error) {
        if (
          branch !== undefined ||
          !(error instanceof WorktreeBranchExistsError) ||
          ++collisions === 10
        )
          throw error;
        // Git atomically claimed this name elsewhere. Retry the same owned checkout,
        // changing only its generated branch; other failures retain normal recovery.
        target.branch = await worktreeBranch(root, undefined, signal);
      }
    }
  }

  managed(limit: number, before?: string) {
    return this.store.listManagedWorktrees(limit, before);
  }

  async validateRemoval(path: string, force: boolean): Promise<void> {
    const owned = await this.store.getManagedWorktree(path);
    if (!owned) throw new WorkspaceOperationError("Harness can only delete its managed worktrees");
    if (await this.#unregistered(owned.repository, path)) {
      if (!force && (await this.#exists(path)))
        throw new WorkspaceOperationError(
          "Unregistered checkout has remaining files; confirm force deletion to discard them",
        );
      return;
    }
    await validateWorktreeRemoval(path, path, force);
  }

  async remove(path: string, force: boolean): Promise<void> {
    const owned = await this.store.getManagedWorktree(path);
    if (!owned) throw new WorkspaceOperationError("Harness can only delete its managed worktrees");
    // The original checkout can itself have disappeared; any surviving linked checkout
    // still provides the shared Git metadata needed to remove this entry.
    const repository = await realpath(owned.repository).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return path;
      throw error;
    });
    if (await this.#unregistered(repository, path)) {
      if (await this.#exists(path)) {
        if (!force)
          throw new WorkspaceOperationError(
            "Unregistered checkout has remaining files; confirm force deletion to discard them",
          );
        await rm(path, { recursive: true });
      }
    } else await removeWorktree(repository, path, force);
    await this.store.deleteManagedWorktree(path);
  }
  async #unregistered(repository: string, path: string): Promise<boolean> {
    return !(await listWorktrees(repository)).some((tree) => tree.path === path);
  }
  async #exists(path: string): Promise<boolean> {
    return stat(path)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
  }
}
