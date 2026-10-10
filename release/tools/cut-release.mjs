import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bumpVersion, cleanSourceCommit, nextVersion, repositoryRoot } from "./version.ts";

const versionPaths = [
  "release/product.json",
  "package.json",
  "package-lock.json",
  "packages/desktop/src-tauri/tauri.conf.json",
  "native/Cargo.toml",
  "packages/desktop/src-tauri/Cargo.toml",
  "native/Cargo.lock",
  "packages/desktop/src-tauri/Cargo.lock",
];
const platforms = [
  {
    target: "windows-x64",
    runner: "windows-2022",
    binary: "harness.exe",
    minimumPlatform: "Windows 10 / Server 2016; WebView2 for desktop",
  },
  {
    target: "linux-x64-glibc",
    runner: "ubuntu-22.04",
    binary: "harness",
    minimumPlatform:
      "kernel 4.18, glibc 2.28, libstdc++ 6.0.25 (GLIBCXX_3.4.25, CXXABI_1.3.11) for CLI/server; Ubuntu 22.04 for desktop",
  },
  {
    target: "macos-x64",
    runner: "macos-15-intel",
    binary: "harness",
    minimumPlatform: "macOS 11",
  },
  {
    target: "macos-arm64",
    runner: "macos-14",
    binary: "harness",
    minimumPlatform: "macOS 11",
  },
];

/** Cut once, then let downstream retries reuse the captured commit and artifacts.
 * A full workflow rerun is rejected before touching versions: use rerun failed
 * jobs after a successful cut. There is no second mutable release selection. */
export async function cutRelease({ root, bump, channel, runAttempt }) {
  if (runAttempt !== "1")
    throw new Error("The source cut cannot be rerun; rerun failed downstream jobs instead");
  if (!["patch", "minor", "major"].includes(bump))
    throw new Error("Expected patch, minor or major");
  if (!["windows-preview", "stable"].includes(channel))
    throw new Error("Expected windows-preview or stable");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, HUSKY: "0" },
    }).trim();
  cleanSourceCommit(root);
  if (git(["symbolic-ref", "--short", "HEAD"]) !== "main")
    throw new Error("Release cuts require the main branch");
  git(["fetch", "--no-tags", "origin", "main"]);
  if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "FETCH_HEAD"]))
    throw new Error("Main changed before the cut; dispatch a new release from current main");
  const current = JSON.parse(await readFile(join(root, "release/product.json"), "utf8")).version;
  const version = nextVersion(current, bump);
  const tag = `v${version}`;
  if (git(["tag", "--list", tag])) throw new Error("The release source tag already exists");
  try {
    git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
    throw new Error("The remote release source tag already exists");
  } catch (error) {
    // git's status 2 is its explicit no-matching-ref result, not a transport failure.
    if (error?.status !== 2) throw error;
  }
  if ((await bumpVersion(root, bump)) !== version) throw new Error("Release version changed");
  const changed = git(["diff", "--name-only", "HEAD"]).split("\n");
  if (
    changed.length !== versionPaths.length ||
    changed.some((path) => !versionPaths.includes(path))
  )
    throw new Error("The version cut changed an unexpected file set");
  git(["add", "--", ...versionPaths]);
  const identity = [
    "-c",
    "user.name=Harness release",
    "-c",
    "user.email=harness-release@users.noreply.github.com",
  ];
  git([
    ...identity,
    "commit",
    "--no-verify",
    "-m",
    `Release ${version}`,
    "-m",
    `Capture the ${channel} product identity before building its exact platform artifacts.`,
  ]);
  const sourceCommit = cleanSourceCommit(root);
  git([...identity, "tag", "-a", tag, "-m", `Harness ${version} (${channel})`]);
  // GitHub supports atomic ref pushes. A moved/protected main or existing tag
  // rejects both refs; the workflow never publishes only half of a source cut.
  git(["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
  const included = channel === "windows-preview" ? platforms.slice(0, 1) : platforms;
  return {
    version,
    tag,
    sourceCommit,
    channel,
    targets: included.map(({ target }) => target).join(","),
    matrix: JSON.stringify({ include: included }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Usage on main: cut-release.mjs patch|minor|major windows-preview|stable");
  if (!process.env.GITHUB_OUTPUT) throw new Error("A GitHub Actions output file is required");
  const result = await cutRelease({
    root: repositoryRoot,
    bump: process.argv[2],
    channel: process.argv[3],
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(result)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  process.stdout.write(`Captured ${result.tag} from ${result.sourceCommit} (${result.channel})\n`);
}
