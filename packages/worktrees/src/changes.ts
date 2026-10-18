import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceOperationError } from "@harness/protocol";
import {
  type ChangeMode,
  type ChangeFile,
  type ChangesPage,
  type FileDiff,
} from "./client-protocol.ts";
import { findRepository, git } from "./git.ts";

const execute = promisify(execFile);
const PATCH_BYTES = 512 * 1024;
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none"];
type ChangedPath = Pick<ChangeFile, "path" | "previousPath" | "status">;
type LineCounts = Pick<ChangeFile, "additions" | "deletions">;
const unknownCounts: LineCounts = { additions: null, deletions: null };

function patchResult(patch: string): FileDiff {
  if (Buffer.byteLength(patch) > PATCH_BYTES || patch.split("\n").length > 10000)
    return {
      patch: "",
      unavailable: "Diff is too large to preview (512 KiB / 10,000 line limit).",
    };
  return { patch, unavailable: null };
}

async function optionalRef(root: string, args: string[], signal?: AbortSignal) {
  try {
    return (await git(root, args, signal)).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === 1) return null;
      if (
        error.code === 128 &&
        args.includes("@{upstream}") &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /no upstream configured|HEAD does not point to a branch|no such branch|not stored as a remote-tracking branch/u.test(
          error.stderr,
        )
      )
        return null;
    }
    throw error;
  }
}

async function comparison(workspace: string | null, mode: ChangeMode, signal?: AbortSignal) {
  const root = workspace === null ? null : await findRepository(workspace);
  if (root === null)
    return {
      root,
      defaultBranch: null,
      upstream: null,
      args: [],
      unborn: false,
      unavailable: "This conversation has no Git checkout.",
    };
  const [remoteRefs, upstream, head] = await Promise.all([
    git(root, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"], signal),
    optionalRef(
      root,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "--verify", "--quiet", "@{upstream}"],
      signal,
    ),
    optionalRef(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal),
  ]);
  const remoteHeads = remoteRefs
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([name, target]) => name?.endsWith("/HEAD") && target);
  let base =
    (remoteHeads.find(([name]) => name === "refs/remotes/origin/HEAD") ?? remoteHeads[0])?.[1] ??
    null;
  if (base === null) {
    for (const name of ["main", "master"]) {
      if (
        await optionalRef(
          root,
          ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`],
          signal,
        )
      ) {
        base = `refs/heads/${name}`;
        break;
      }
    }
  }
  const defaultBranch = base?.replace(/^refs\/(?:heads\/|remotes\/[^/]+\/)/u, "") ?? null;
  let unavailable: string | null = null;
  let args: string[] = [];
  const unborn = head === null;
  switch (mode) {
    case "uncommitted":
      args = unborn ? [] : [head];
      break;
    case "unstaged":
      break;
    case "staged":
      args = ["--cached"];
      break;
    case "branch":
    case "unpushed": {
      const ref = mode === "branch" ? base : upstream;
      if (ref === null)
        unavailable =
          mode === "branch"
            ? "No default branch (main/master) was found."
            : "This branch has no upstream tracking branch.";
      else if (head === null) unavailable = "This checkout has no commits yet.";
      else {
        const mergeBase = await optionalRef(root, ["merge-base", ref, head], signal);
        if (mergeBase === null) unavailable = `No common ancestor with ${ref}.`;
        else args = [mergeBase, head];
      }
      break;
    }
  }
  return { root, defaultBranch, upstream, args, unborn, unavailable };
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function filesOf(root: string, args: string[], signal?: AbortSignal): Promise<ChangedPath[]> {
  const fields = paths(
    await git(root, ["diff", ...diffOptions, "--name-status", "-z", ...args, "--"], signal),
  );
  const files: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const raw = fields[index++]!;
    const status = raw[0] as ChangeFile["status"];
    if (!["A", "M", "D", "R", "C", "T", "U"].includes(status))
      throw new Error(`Unexpected Git change status: ${raw}`);
    const previousPath = status === "R" || status === "C" ? fields[index++] : null;
    const path = fields[index++];
    if (path === undefined || previousPath === undefined)
      throw new Error("Incomplete Git change record");
    files.push({ path, previousPath, status });
  }
  const unique = new Map<string, ChangedPath>();
  for (const file of files) if (unique.get(file.path)?.status !== "U") unique.set(file.path, file);
  return [...unique.values()];
}

async function lineCounts(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Map<string, LineCounts>> {
  const fields = paths(
    await git(root, ["diff", ...diffOptions, "--numstat", "-z", ...args, "--"], signal),
  );
  const counts = new Map<string, LineCounts>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++]!;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("Incomplete Git line-count record");
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    if (path === "") {
      index++; // A rename has separate NUL-delimited source and destination paths.
      path = fields[index++]!;
    }
    if (!path || !/^(?:\d+|-)$/u.test(added) || !/^(?:\d+|-)$/u.test(removed))
      throw new Error("Invalid Git line-count record");
    counts.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: removed === "-" ? null : Number(removed),
    });
  }
  return counts;
}

function patchCounts(diff: FileDiff): LineCounts {
  if (diff.unavailable !== null) return unknownCounts;
  let additions = 0;
  let deletions = 0;
  let hunk = false;
  for (const line of diff.patch.split("\n")) {
    if (line.startsWith("@@ ")) hunk = true;
    else if (line.startsWith("diff ")) hunk = false;
    else if (hunk && line.startsWith("+")) additions++;
    else if (hunk && line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export async function listChanges(
  workspace: string | null,
  params: {
    mode: ChangeMode;
    after: string | null;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<ChangesPage> {
  const mode = params.mode;
  const c = await comparison(workspace, mode, signal);
  const result: ChangesPage = {
    repository: c.root,
    defaultBranch: c.defaultBranch,
    upstream: c.upstream,
    unavailable: c.unavailable,
    files: [],
    nextCursor: null,
  };
  if (c.root === null || c.unavailable !== null) return result;
  let files: ChangedPath[];
  const reconciled = new Set<string>();
  if (mode === "uncommitted" && c.unborn) {
    const tracked = paths(await git(c.root, ["ls-files", "--cached", "-z"], signal));
    files = tracked.map((path) => ({ path, previousPath: null, status: "A" }));
  } else files = await filesOf(c.root, c.args, signal);
  if (mode === "uncommitted" || mode === "unstaged") {
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const path of paths(
      await git(c.root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
    )) {
      if (mode === "uncommitted" && byPath.has(path)) {
        // Removing a path from the index can report it as both deleted and
        // untracked. Uncommitted compares its actual content with HEAD once.
        const info = await lstat(join(c.root, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) continue;
        const [before, after] = info.isSymbolicLink()
          ? await Promise.all([
              git(c.root, ["cat-file", "blob", `HEAD:${path}`], signal),
              readlink(join(c.root, path)),
            ])
          : await Promise.all([
              git(c.root, ["rev-parse", `HEAD:${path}`], signal),
              git(c.root, ["hash-object", "--", path], signal),
            ]);
        if (before === after) byPath.delete(path);
        else {
          byPath.set(path, { path, previousPath: null, status: "M" });
          reconciled.add(path);
        }
      } else byPath.set(path, { path, previousPath: null, status: "?" });
    }
    files = [...byPath.values()];
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const remaining =
    params.after === null ? files : files.filter((file) => file.path > params.after!);
  const page: ChangedPath[] = [];
  for (const file of remaining) {
    signal?.throwIfAborted();
    if (mode === "uncommitted" && c.unborn) {
      const present = await lstat(join(c.root, file.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!present) continue;
    }
    page.push(file);
    if (page.length > params.limit) break;
  }
  const counts =
    page.length && !(mode === "uncommitted" && c.unborn)
      ? await lineCounts(c.root, c.args, signal)
      : new Map<string, LineCounts>();
  for (const file of page.slice(0, params.limit)) {
    let count = counts.get(file.path) ?? unknownCounts;
    if (file.status === "?" || (mode === "uncommitted" && c.unborn) || reconciled.has(file.path)) {
      count = await addedFile(
        c.root,
        file.path,
        reconciled.has(file.path) ? c.args[0] : undefined,
        signal,
      )
        .then(patchCounts)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
            return unknownCounts;
          throw error;
        });
    }
    result.files.push({ ...file, ...count });
  }
  if (page.length > params.limit) result.nextCursor = result.files.at(-1)!.path;
  return result;
}

function validatePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === ".." || part === ".git" || part === "")
  )
    throw new WorkspaceOperationError("Expected a repository-relative file path");
}

async function workingBytes(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer | string> {
  signal?.throwIfAborted();
  const info = await lstat(join(root, path));
  if (info.size > PATCH_BYTES) return "File is too large to preview (512 KiB limit).";
  let bytes: Buffer;
  if (info.isSymbolicLink()) bytes = Buffer.from(await readlink(join(root, path)));
  else if (info.isFile()) {
    // Read once into a bounded buffer even if another process grows the file.
    const file = await open(join(root, path), "r");
    try {
      bytes = Buffer.alloc(PATCH_BYTES + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, read.bytesRead);
    } finally {
      await file.close();
    }
  } else return "This entry is not a regular file.";
  signal?.throwIfAborted();
  if (bytes.length > PATCH_BYTES) return "File is too large to preview (512 KiB limit).";
  return bytes;
}

async function addedFile(
  root: string,
  path: string,
  head: string | undefined,
  signal?: AbortSignal,
): Promise<FileDiff> {
  const bytes = await workingBytes(root, path, signal).catch((error: NodeJS.ErrnoException) => {
    // An atomic save can replace an untracked file after Git listed it. Keep a
    // normal readable state so the next open-tab refresh can reconcile it.
    if (error.code === "ENOENT") return "File changed while reading; refreshing…";
    throw error;
  });
  if (typeof bytes === "string") return { patch: "", unavailable: bytes };
  const oldName = JSON.stringify(`a/${path}`);
  const newName = JSON.stringify(`b/${path}`);
  if (
    head &&
    (await optionalRef(root, ["rev-parse", "--verify", "--quiet", `${head}:${path}`], signal))
  ) {
    // Git still supplies the patch for a file removed from the index. Temporary
    // inputs avoid writing Git objects or altering the user's index.
    let directory: string | undefined;
    try {
      const { stdout: before } = await execute(
        "git",
        ["-C", root, "cat-file", "--filters", `${head}:${path}`],
        {
          encoding: "buffer",
          maxBuffer: PATCH_BYTES,
          ...(signal ? { signal } : {}),
        },
      );
      if (before.includes(0) || bytes.includes(0))
        return { patch: "", unavailable: "Binary file." };
      directory = await mkdtemp(join(tmpdir(), "harness-file-diff-"));
      const oldPath = join(directory, "before");
      const newPath = join(directory, "after");
      await writeFile(oldPath, before);
      await writeFile(newPath, bytes);
      let patch: string;
      try {
        patch = (
          await execute("git", ["diff", ...diffOptions, "--no-index", "--", oldPath, newPath], {
            encoding: "utf8",
            maxBuffer: PATCH_BYTES,
            ...(signal ? { signal } : {}),
          })
        ).stdout;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === 1 &&
          "stdout" in error &&
          typeof error.stdout === "string"
        ))
          throw error;
        patch = error.stdout;
      }
      return patchResult(
        patch
          .replace(/^diff --git .*$/mu, () => `diff --git ${oldName} ${newName}`)
          .replace(/^--- .*$/mu, () => `--- ${oldName}`)
          .replace(/^\+\+\+ .*$/mu, () => `+++ ${newName}`),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      )
        return { patch: "", unavailable: "Diff is too large to preview (512 KiB limit)." };
      throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  if (bytes.includes(0)) return { patch: "", unavailable: "Binary file." };
  const text = bytes.toString("utf8");
  const lines = text === "" ? [] : text.replace(/\n$/u, "").split("\n");
  return patchResult(
    `diff --git ${oldName} ${newName}\n--- /dev/null\n+++ ${newName}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${text.endsWith("\n") || text === "" ? "" : "\n\\ No newline at end of file"}`,
  );
}

export async function readChangeDiff(
  workspace: string | null,
  params: { mode: ChangeMode; path: string; previousPath?: string | null },
  signal?: AbortSignal,
): Promise<FileDiff> {
  validatePath(params.path);
  if (params.previousPath) validatePath(params.previousPath);
  const mode = params.mode;
  const c = await comparison(workspace, mode, signal);
  if (c.root === null || c.unavailable !== null) return { patch: "", unavailable: c.unavailable };
  if (mode === "uncommitted" || mode === "unstaged") {
    const untracked = paths(
      await git(
        c.root,
        ["ls-files", "--others", "--exclude-standard", "-z", "--", params.path],
        signal,
      ),
    );
    const unborn = mode === "uncommitted" && c.unborn;
    const tracked = unborn
      ? paths(await git(c.root, ["ls-files", "--cached", "-z", "--", params.path], signal))
      : [];
    if (untracked.includes(params.path) || tracked.includes(params.path))
      return addedFile(c.root, params.path, mode === "uncommitted" ? c.args[0] : undefined, signal);
  }
  try {
    const { stdout } = await execute(
      "git",
      [
        "--literal-pathspecs",
        "-C",
        c.root,
        "diff",
        ...diffOptions,
        "--patch",
        ...c.args,
        "--",
        params.path,
        ...(params.previousPath ? [params.previousPath] : []),
      ],
      {
        encoding: "utf8",
        maxBuffer: PATCH_BYTES,
        ...(signal ? { signal } : {}),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
    );
    return patchResult(stdout);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      return { patch: "", unavailable: "Diff is too large to preview (512 KiB limit)." };
    throw error;
  }
}
