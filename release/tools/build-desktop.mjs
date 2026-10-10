import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { nativeTarget } from "../../scripts/native-target.mjs";
import { recordDesktopBuild } from "./artifacts.ts";
import { cleanSourceCommit, repositoryRoot } from "./version.ts";

const sourceCommit = cleanSourceCommit(repositoryRoot);
const target = nativeTarget();
const platform = process.platform;
const payloads = join(repositoryRoot, "release/output", target.release);
const scratch = join(payloads, "desktop-build");
await mkdir(payloads, { recursive: true });
// One successful fresh Tauri invocation owns this build record. Never pick an
// installer left over from a previous invocation or another target's directory.
await mkdir(scratch);
const bundle = platform === "win32" ? "nsis" : platform === "darwin" ? "dmg" : "appimage";
const config = join(scratch, "tauri.release.json");
const publicKey = (
  await readFile(join(repositoryRoot, "release/verification-key.pub"), "utf8")
).trim();
await writeFile(
  config,
  JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: publicKey } },
  }),
);
execFileSync(
  process.execPath,
  [
    join(repositoryRoot, "packages/desktop/tools/native.mjs"),
    "desktop-release",
    "--ci",
    "--target",
    target.rust,
    "--bundles",
    bundle,
    "--config",
    config,
  ],
  {
    cwd: join(repositoryRoot, "packages/desktop"),
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: scratch },
  },
);
const built = join(scratch, target.rust, "release");
const one = async (directory, suffix) => {
  const names = (await readdir(directory)).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${directory}`);
  return join(directory, names[0]);
};
const directory = join(built, "bundle", bundle);
const installer = await one(
  directory,
  platform === "win32" ? ".exe" : platform === "darwin" ? ".dmg" : ".AppImage",
);
const update =
  platform === "darwin" ? await one(join(built, "bundle/macos"), ".app.tar.gz") : installer;
await recordDesktopBuild({
  executable: join(built, `harness-desktop${platform === "win32" ? ".exe" : ""}`),
  installer,
  update,
  sourceCommit,
  output: join(payloads, "desktop"),
});
process.stderr.write(`Captured fresh ${target.release} desktop build and updater bytes.\n`);
