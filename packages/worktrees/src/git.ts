import { WorkspaceOperationError } from "@harness/protocol";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...(signal ? { signal } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}

export async function findRepository(cwd: string): Promise<string | null> {
  let directory = resolve(cwd);
  const exists = await stat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!exists?.isDirectory()) return null;
  for (;;) {
    const marker = await stat(join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (marker) return repositoryRoot(directory);
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
}

export async function gitDirectories(cwd: string): Promise<{ common: string; private: string }> {
  const common = (
    await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  const privatePath = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  return { common: await realpath(common), private: await realpath(privatePath) };
}

export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const output = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const trees: GitWorktree[] = [];
  for (const record of output.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!path) throw new Error("Git worktree listing omitted its path");
    if (fields.includes("bare")) continue;
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    if (!head) throw new Error("Git worktree listing omitted HEAD");
    const branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
    trees.push({
      path: resolve(path),
      head,
      branch: branch?.replace(/^refs\/heads\//, "") ?? null,
      locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
    });
  }
  return trees;
}

export function worktreeDirectory(configured?: string): string {
  if (!configured) return join(homedir(), ".harness", "worktrees");
  const expanded =
    configured === "~"
      ? homedir()
      : configured.startsWith("~/")
        ? join(homedir(), configured.slice(2))
        : configured;
  if (!isAbsolute(expanded))
    throw new WorkspaceOperationError("Worktree directory must be an absolute path");
  return resolve(expanded);
}

export async function allocateWorktree(
  directory: string,
): Promise<{ path: string; branch: string }> {
  const id = randomUUID();
  await mkdir(directory, { recursive: true });
  return { path: join(await realpath(directory), id), branch: `harness/${id}` };
}

export async function addWorktree(
  cwd: string,
  target: { path: string; branch: string },
  signal?: AbortSignal,
): Promise<GitWorktree> {
  await git(cwd, ["worktree", "add", "-b", target.branch, "--", target.path, "HEAD"], signal);
  const tree = (await listWorktrees(cwd)).find((entry) => entry.path === target.path);
  if (!tree) throw new Error("Created worktree is missing from Git metadata");
  return tree;
}

export async function validateWorktreeRemoval(
  cwd: string,
  path: string,
  force: boolean,
): Promise<void> {
  const tree = (await listWorktrees(cwd)).find((entry) => resolve(entry.path) === resolve(path));
  if (!tree) throw new Error("Worktree is not registered in this repository");
  const directories = await gitDirectories(tree.path);
  if (directories.common === directories.private)
    throw new WorkspaceOperationError("Cannot delete the primary checkout");
  if (tree.locked)
    throw new WorkspaceOperationError("Worktree is locked; unlock it in Git before deletion");
  if (!force && (await git(tree.path, ["status", "--porcelain", "-z", "--untracked-files=normal"])))
    throw new WorkspaceOperationError(
      "Worktree has uncommitted or untracked files; confirm force deletion to discard them",
    );
}

export async function removeWorktree(cwd: string, path: string, force: boolean): Promise<void> {
  const tree = (await listWorktrees(cwd)).find((entry) => resolve(entry.path) === resolve(path));
  if (!tree) throw new Error("Worktree is not registered in this repository");
  const directories = await gitDirectories(tree.path);
  if (directories.common === directories.private)
    throw new WorkspaceOperationError("Cannot delete the primary checkout");
  await git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), "--", tree.path]);
}

/** Linked checkouts need their shared metadata exposed separately by an execution backend. */
export async function linkedGitDirectories(
  cwd: string,
): Promise<{ common: string; private: string } | undefined> {
  let directory = resolve(cwd);
  for (;;) {
    const marker = await stat(join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (marker) return marker.isFile() ? gitDirectories(directory) : undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
