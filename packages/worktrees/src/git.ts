import { WorkspaceOperationError } from "@harness/protocol";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
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
    // A branch-exists failure is the one Git diagnostic creation may retry.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
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

const adjectives = [
  "bright",
  "brisk",
  "calm",
  "clever",
  "gentle",
  "happy",
  "keen",
  "lively",
  "lucky",
  "merry",
  "nimble",
  "quiet",
  "swift",
  "tidy",
  "warm",
  "wise",
];
const animals = [
  "badger",
  "bear",
  "crane",
  "deer",
  "falcon",
  "finch",
  "fox",
  "heron",
  "lynx",
  "otter",
  "owl",
  "panda",
  "raven",
  "seal",
  "tiger",
  "wolf",
];

/** Choose against all local branches, including ones without a checkout. Git owns the refs. */
export async function worktreeBranch(
  cwd: string,
  requested?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (requested !== undefined) {
    let validated: string;
    try {
      validated = (await git(cwd, ["check-ref-format", "--branch", requested], signal)).trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 128)
        throw new WorkspaceOperationError("Git rejected the branch name", { cause: error });
      throw error;
    }
    if (validated !== requested) throw new WorkspaceOperationError("Use a literal Git branch name");
  }
  const branches = (
    await git(cwd, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"], signal)
  )
    .split("\n")
    .filter(Boolean);
  const conflicts = (name: string) =>
    branches.some(
      (branch) => branch === name || branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`),
    );
  if (requested !== undefined) {
    if (conflicts(requested))
      throw new WorkspaceOperationError("Branch name conflicts with an existing branch");
    return requested;
  }
  if (branches.includes("harness"))
    throw new WorkspaceOperationError(
      "The branch 'harness' prevents generated worktree branch names; specify a branch name",
    );
  const base = `harness/${adjectives[randomInt(adjectives.length)]}-${animals[randomInt(animals.length)]}`;
  // Each existing ref can block at most one candidate once the shared prefix is available.
  for (let suffix = 1; suffix <= branches.length + 1; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!conflicts(candidate)) return candidate;
  }
  throw new Error("Worktree branch allocation exhausted unexpectedly");
}

export async function allocateWorktree(
  directory: string,
  branch: string,
): Promise<{ path: string; branch: string }> {
  const id = randomUUID();
  await mkdir(directory, { recursive: true });
  return { path: join(await realpath(directory), id), branch };
}

export class WorktreeBranchExistsError extends WorkspaceOperationError {}

export async function addWorktree(
  cwd: string,
  target: { path: string; branch: string; head: string },
  signal?: AbortSignal,
): Promise<GitWorktree> {
  try {
    await git(
      cwd,
      ["worktree", "add", "-b", target.branch, "--", target.path, target.head],
      signal,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === 128 || error.code === 255) &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr
        .split(/\r?\n/u)
        .some(
          (line) =>
            line === `fatal: a branch named '${target.branch}' already exists` ||
            line ===
              `fatal: cannot lock ref 'refs/heads/${target.branch}': reference already exists`,
        )
    )
      throw new WorktreeBranchExistsError("Branch name conflicts with an existing branch", {
        cause: error,
      });
    throw error;
  }
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
