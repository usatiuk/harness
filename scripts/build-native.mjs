import { execFileSync } from "node:child_process";
import { copyFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { nativeTarget } from "./native-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = nativeTarget();
execFileSync(
  process.execPath,
  [
    join(root, "packages/desktop/tools/native.mjs"),
    "cargo",
    "build",
    "--locked",
    "--manifest-path",
    join(root, "native/Cargo.toml"),
    "--target",
    target.rust,
    "--target-dir",
    join(root, "native/target"),
    "-p",
    "harness-native",
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
// A fresh inode avoids macOS retaining the overwritten library's code-signing pages.
const temporary = join(root, "packages/native", `harness-native-${randomUUID()}.node`);
try {
  await copyFile(join(root, "native/target", target.rust, "debug", target.library), temporary);
  await rename(temporary, join(root, "packages/native/harness-native.node"));
} finally {
  await rm(temporary, { force: true });
}
