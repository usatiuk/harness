import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
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
await copyFile(
  join(root, "native/target", target.rust, "debug", target.library),
  join(root, "packages/native/harness-native.node"),
);
