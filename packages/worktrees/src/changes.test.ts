import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as filesystem from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { listChanges, readChangeDiff } from "./changes.ts";
import type { ChangeMode } from "./client-protocol.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

it("keeps literal patch headers and Git line-ending conversion for index removals", async () => {
  const { root, git, list, diff } = await fixture();
  const path = "literal$&.txt";
  await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
  await writeFile(join(root, path), "one\r\ntwo\r\n");
  await git("add", ".");
  await git("commit", "-m", "CRLF");
  await git("rm", "--cached", "--", path);
  expect((await list("uncommitted")).files).toEqual([]);
  await writeFile(join(root, path), "one\r\nchanged\r\n");
  const patch = (await diff("uncommitted", path)).patch;
  expect(patch).toContain(`--- "a/${path}"`);
  expect(patch).toContain(`+++ "b/${path}"`);
  expect(patch).toContain(" one\n-two\n+changed\n");
});

it("recovers an untracked-file atomic-save race on the next read", async () => {
  const { root, diff } = await fixture();
  await writeFile(join(root, "new.txt"), "new\n");
  vi.mocked(filesystem.lstat).mockRejectedValueOnce(
    Object.assign(new Error("Replaced"), { code: "ENOENT" }),
  );
  expect((await diff("uncommitted", "new.txt")).unavailable).toContain(
    "File changed while reading",
  );
  expect((await diff("uncommitted", "new.txt")).patch).toContain("+new");
});

it.skipIf(process.platform === "win32")(
  "compares index-removed symlinks without following their targets",
  async () => {
    const { root, git, list, diff } = await fixture();
    await symlink("missing target", join(root, "link"));
    await git("add", "link");
    await git("commit", "-m", "Link");
    await git("rm", "--cached", "link");
    expect((await list("uncommitted")).files).toEqual([]);
    await rm(join(root, "link"));
    await symlink("different target", join(root, "link"));
    expect((await list("uncommitted")).files).toEqual([
      { path: "link", previousPath: null, status: "M", additions: 1, deletions: 1 },
    ]);
    expect((await diff("uncommitted", "link")).patch).toContain("+different target");
  },
);
async function fixture(commit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-changes-")));
  roots.push(root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  vi.stubEnv("GIT_DIR", undefined);
  vi.stubEnv("GIT_WORK_TREE", undefined);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Harness Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "file.txt"), "original\n");
  if (commit) {
    await git("add", ".");
    await git("commit", "-m", "Initial");
  }
  const list = (mode: ChangeMode, after: string | null = null, limit = 200) =>
    listChanges(root, { mode, after, limit });
  const diff = (mode: ChangeMode, path = "file.txt") => readChangeDiff(root, { mode, path });
  return { root, git, list, diff };
}

it("separates staged and unstaged changes, includes untracked files, and pages literal file names", async () => {
  const { root, git, list, diff } = await fixture();
  await writeFile(join(root, "file.txt"), "staged\n");
  await git("add", "file.txt");
  await writeFile(join(root, "file.txt"), "unstaged\n");
  await writeFile(join(root, "new [1].txt"), "new\n");
  await writeFile(join(root, "new 1.txt"), "other\n");
  expect((await diff("staged")).patch).toContain("+staged");
  expect((await diff("staged")).patch).not.toContain("unstaged");
  expect((await diff("unstaged")).patch).toContain("-staged\n+unstaged");
  expect((await diff("uncommitted")).patch).toContain("-original\n+unstaged");
  expect((await list("staged")).files.map((file) => file.path)).toEqual(["file.txt"]);
  const first = await list("uncommitted", null, 1);
  const second = await list("uncommitted", first.nextCursor, 1);
  const third = await list("uncommitted", second.nextCursor, 1);
  expect([...first.files, ...second.files, ...third.files].map((file) => file.path)).toEqual([
    "file.txt",
    "new 1.txt",
    "new [1].txt",
  ]);
  expect(third.nextCursor).toBeNull();
  expect((await diff("unstaged", "new [1].txt")).patch).toContain("+new");
  expect((await diff("unstaged", "new [1].txt")).patch).not.toContain("+other");
});

it("compares committed branch work from the merge base, excluding dirty and upstream-only changes", async () => {
  const { root, git, list, diff } = await fixture();
  await git("checkout", "-b", "feature");
  await writeFile(join(root, "file.txt"), "feature\n");
  await git("commit", "-am", "Feature");
  await git("checkout", "main");
  await writeFile(join(root, "main-only.txt"), "main only\n");
  await git("add", ".");
  await git("commit", "-m", "Main advances");
  await git("remote", "add", "origin", root);
  await git("update-ref", "refs/remotes/origin/main", "main");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "feature");
  await git("branch", "--set-upstream-to=origin/main");
  await writeFile(join(root, "file.txt"), "dirty\n");
  for (const mode of ["branch", "unpushed"] as const) {
    const page = await list(mode);
    expect(page.files.map((file) => file.path)).toEqual(["file.txt"]);
    expect(page.defaultBranch).toBe("main");
    expect(page.upstream).toBe("origin/main");
    expect((await diff(mode)).patch).toContain("+feature");
    expect((await diff(mode)).patch).not.toContain("dirty");
  }
  await git("remote", "rename", "origin", "upstream");
  expect((await list("branch")).defaultBranch).toBe("main");
  expect((await list("unpushed")).upstream).toBe("upstream/main");
  await git("update-ref", "-d", "refs/remotes/upstream/main");
  expect((await list("unpushed")).unavailable).toContain("no upstream");
});

it("shows unborn, binary, empty, deleted and renamed files without changing Git state", async () => {
  const { root, git, list, diff } = await fixture(false);
  await git("add", "file.txt");
  await writeFile(join(root, "file.txt"), "latest\n");
  expect((await list("uncommitted")).files).toEqual([
    { path: "file.txt", status: "A", previousPath: null, additions: 1, deletions: 0 },
  ]);
  expect((await diff("uncommitted")).patch).toContain("+latest");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "empty"), "");
  expect((await diff("uncommitted", "binary")).unavailable).toBe("Binary file.");
  expect((await diff("uncommitted", "empty")).patch).toContain('+++ "b/empty"');
  await git("add", ".");
  await git("commit", "-m", "Initial");
  await git("mv", "file.txt", "renamed.txt");
  await rm(join(root, "empty"));
  const before = await readFile(join(root, ".git", "index"));
  expect((await list("uncommitted")).files).toEqual(
    expect.arrayContaining([
      { path: "renamed.txt", status: "R", previousPath: "file.txt", additions: 0, deletions: 0 },
      { path: "empty", status: "D", previousPath: null, additions: 0, deletions: 0 },
    ]),
  );
  expect((await diff("uncommitted", "empty")).patch).toContain("deleted file");
  expect(
    (
      await readChangeDiff(root, {
        mode: "uncommitted",
        path: "renamed.txt",
        previousPath: "file.txt",
      })
    ).patch,
  ).toContain("rename from file.txt");
  expect(await readFile(join(root, ".git", "index"))).toEqual(before);
});

it("reconciles index removals and unresolved conflicts into unique file sections", async () => {
  const { root, git, list, diff } = await fixture();
  await git("rm", "--cached", "file.txt");
  expect((await list("uncommitted")).files).toEqual([]);
  await writeFile(join(root, "file.txt"), "changed while untracked\n");
  expect((await list("uncommitted")).files).toEqual([
    { path: "file.txt", previousPath: null, status: "M", additions: 1, deletions: 1 },
  ]);
  const patch = (await diff("uncommitted")).patch;
  expect(patch).toContain("-original\n+changed while untracked");
  expect(patch).not.toContain("harness-file-diff-");
  await git("reset", "--hard", "HEAD");
  await git("checkout", "-b", "other");
  await writeFile(join(root, "file.txt"), "other\n");
  await git("commit", "-am", "Other");
  await git("checkout", "main");
  await writeFile(join(root, "file.txt"), "main\n");
  await git("commit", "-am", "Main");
  await expect(git("merge", "other")).rejects.toThrow();
  expect((await list("unstaged")).files).toEqual([
    { path: "file.txt", previousPath: null, status: "U", additions: 4, deletions: 0 },
  ]);
  expect((await diff("unstaged")).patch).toContain("<<<<<<< HEAD");
});

it("explains missing checkout/refs, bounds previews, rejects unsafe paths, and honors cancellation", async () => {
  const { root, list, diff } = await fixture();
  expect(
    (await listChanges(null, { mode: "uncommitted", after: null, limit: 20 })).unavailable,
  ).toContain("no Git checkout");
  expect((await list("unpushed")).unavailable).toContain("no upstream");
  await writeFile(join(root, "large"), "x".repeat(600 * 1024));
  expect((await diff("uncommitted", "large")).unavailable).toContain("too large");
  await writeFile(join(root, "many-lines"), "\n".repeat(10001));
  expect((await diff("uncommitted", "many-lines")).unavailable).toContain("10,000 line limit");
  for (const path of ["../outside", "/etc/passwd", ".git/config", "nested/../../outside", "a\\b"])
    await expect(diff("uncommitted", path)).rejects.toThrow("repository-relative");
  await expect(
    listChanges(root, { mode: "uncommitted", after: null, limit: 20 }, AbortSignal.abort()),
  ).rejects.toThrow();
});

it("keeps binary index-removal counts unavailable and temporary paths out of diffs", async () => {
  const { root, git, list, diff } = await fixture();
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await git("add", "binary");
  await git("commit", "-m", "Binary");
  await git("rm", "--cached", "binary");
  for (const content of [Buffer.from([0, 2, 3]), Buffer.from("now text\n")]) {
    await writeFile(join(root, "binary"), content);
    expect((await list("uncommitted")).files).toEqual([
      { path: "binary", previousPath: null, status: "M", additions: null, deletions: null },
    ]);
    expect(await diff("uncommitted", "binary")).toEqual({ patch: "", unavailable: "Binary file." });
  }
});

it("counts changed lines in tracked, untracked, binary and literal-name files", async () => {
  const { root, git, list } = await fixture();
  await writeFile(join(root, "file.txt"), "staged\nsecond\n");
  await git("add", "file.txt");
  await writeFile(join(root, "file.txt"), "working\nsecond\nthird\n");
  await writeFile(join(root, "tab\tand\nnewline"), "one\ntwo");
  await writeFile(join(root, "binary"), Buffer.from([0, 1]));
  await writeFile(join(root, "empty"), "");
  expect((await list("staged")).files[0]).toMatchObject({ additions: 2, deletions: 1 });
  expect((await list("unstaged")).files.find((file) => file.path === "file.txt")).toMatchObject({
    additions: 2,
    deletions: 1,
  });
  expect((await list("uncommitted")).files).toEqual([
    { path: "binary", previousPath: null, status: "?", additions: null, deletions: null },
    { path: "empty", previousPath: null, status: "?", additions: 0, deletions: 0 },
    { path: "file.txt", previousPath: null, status: "M", additions: 3, deletions: 1 },
    { path: "tab\tand\nnewline", previousPath: null, status: "?", additions: 2, deletions: 0 },
  ]);
  await git("add", ".");
  expect(
    (await list("staged")).files.find((file) => file.path === "tab\tand\nnewline"),
  ).toMatchObject({ additions: 2, deletions: 0 });
});

it("quotes synthetic Git headers for literal newline and quote filenames", async () => {
  const { root, git, diff } = await fixture();
  const path = 'odd\n@@bad".txt';
  await writeFile(join(root, path), "new\n");
  const patch = (await diff("uncommitted", path)).patch;
  const header = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`;
  expect(patch.startsWith(header)).toBe(true);
  expect(patch).toContain(`+++ ${JSON.stringify(`b/${path}`)}\n`);
  expect(patch).toContain("+new");
  await git("add", ".");
  await git("commit", "-m", "Literal name");
  await git("rm", "--cached", "--", path);
  await writeFile(join(root, path), "changed\n");
  expect((await diff("uncommitted", path)).patch.startsWith(header)).toBe(true);
});
