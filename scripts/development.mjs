import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { nativeTarget } from "./native-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
const target = nativeTarget();
if (!["cli", "node", "npm"].includes(mode)) throw new Error("Choose a development bootstrap mode");
const env = {
  ...process.env,
  HARNESS_HOME: process.env.HARNESS_HOME ?? join(root, ".harness-dev"),
};
delete env.HARNESS_SERVER_ENTRY;
delete env.HARNESS_SERVER_PAYLOAD;
delete env.HARNESS_SERVER_NODE;
delete env.HARNESS_SERVER_SELECTION;
delete env.HARNESS_SERVER_CACHE_KEYS;
delete env.HARNESS_NATIVE_LAUNCHER;
delete env.HARNESS_DEVELOPMENT_SERVER_PAYLOAD;
// Source Node and the addon must use the host target and this checkout's output.
delete env.CARGO_BUILD_TARGET;
env.CARGO_TARGET_DIR = join(root, "native/target");
const buildArgs = [
  "build",
  "--quiet",
  "--manifest-path",
  join(root, "native/Cargo.toml"),
  "--workspace",
  "--target",
  target.rust,
  "--target-dir",
  join(root, "native/target"),
];
const args = [
  mode === "cli" ? "--development" : mode === "npm" ? "--npm" : "--run-node",
  root,
  ...process.argv.slice(3),
];
let child;
function run(command, args) {
  return new Promise((resolve, reject) => {
    // Reuse the caller's console for interactive use. Keeping stdio inherited
    // also lets nested npm/test commands reuse a hidden automation console.
    child = spawn(command, args, { stdio: "inherit", env, windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
// The application child handles terminal signals. Keep the bootstrap owner alive to await it.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child?.kill("SIGTERM"));
let result = await run("cargo", buildArgs);
if (result.code === 0) {
  const library = join(root, "native/target", target.rust, "debug", target.library);
  const bytes = await readFile(library);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, ".native-dev");
  await mkdir(directory, { recursive: true });
  const binding = join(directory, `${digest}.node`);
  // Publish complete immutable bytes without replacing a binding loaded by a
  // concurrent source process. The digest and publication use the same read.
  const staged = join(directory, `${randomUUID()}.staging`);
  await writeFile(staged, bytes, { flag: "wx" });
  try {
    try {
      await link(staged, binding);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(staged);
  }
  env.HARNESS_NATIVE_BINDING = binding;
  // Run the lock owner directly so cooperative termination reaches it, rather
  // than terminating an intermediate `cargo run` process and orphaning it.
  const executable = join(
    root,
    "native/target",
    target.rust,
    "debug",
    process.platform === "win32" ? "harness.exe" : "harness",
  );
  if (mode === "cli") {
    result = await run(executable, [
      "--run-node",
      root,
      "release/tools/build-payloads.mjs",
      "--server-only",
    ]);
    if (result.code === 0)
      env.HARNESS_DEVELOPMENT_SERVER_PAYLOAD = join(
        root,
        "release/output",
        target.release,
        "server",
      );
  }
  if (result.code === 0) result = await run(executable, args);
}
process.exitCode = result.code ?? 1;
