import type { ManagedWorktree } from "./store.ts";

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
};

/** Git ownership and operations; execution and conversation lifetime stay with their owners. */
export interface WorktreeOperations {
  repository(path: string): Promise<string | null>;
  inspect(path: string): Promise<WorktreeInfo>;
  list(repository: string): Promise<WorktreeInfo[]>;
  create(repository: string, signal?: AbortSignal): Promise<WorktreeInfo>;
  managed(limit: number, before?: string): Promise<ManagedWorktree[]>;
  validateRemoval(path: string, force: boolean): Promise<void>;
  remove(path: string, force: boolean): Promise<void>;
}

export type WorkspaceSelection =
  { kind: "original" } | { kind: "new" } | { kind: "existing"; path: string };

/** An expected workspace refusal whose message is safe to display to the user. */
export class WorkspaceOperationError extends Error {}
