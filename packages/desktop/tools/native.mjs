import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { buildIdentity } from "../../../release/tools/build-payloads.mjs";
const require = createRequire(import.meta.url);
let [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Expected a native command");
const env = { ...process.env };
if (command === "desktop-release") {
  const identity = await buildIdentity("release");
  env.HARNESS_RELEASE_BUILD = "1";
  env.HARNESS_SOURCE_COMMIT = identity.sourceCommit;
  command = "tauri";
  args.unshift("build");
}
if (command === "tauri") {
  command = process.execPath;
  args.unshift(require.resolve("@tauri-apps/cli/tauri.js"));
}
if (process.platform === "win32") {
  args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    fileURLToPath(new URL("./native.ps1", import.meta.url)),
    command,
    ...args,
  ];
  command = "powershell.exe";
}
const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true, env });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
