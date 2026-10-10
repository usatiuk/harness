import { spawn } from "node:child_process";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { remoteProcessFixture } from "@harness/testkit";
import { canonicalHome } from "../src/local.ts";

if (process.platform !== "win32" || !process.env.HARNESS_REMOTE_WSL)
  throw new Error("Set HARNESS_REMOTE_WSL to an installed distribution on Windows");
const payload = process.env.HARNESS_DEVELOPMENT_REMOTE_PAYLOAD;
if (!payload)
  throw new Error(
    "Build a Linux payload with prepare:remote and set HARNESS_DEVELOPMENT_REMOTE_PAYLOAD",
  );
await readFile(join(payload, "remote.json"));
const home = await canonicalHome(join(tmpdir(), `harness-wsl-${randomUUID()}`));
const fixtureHome = `/tmp/harness-remote-${randomUUID()}`;
const preload = await remoteProcessFixture(
  home,
  `export HOME='${fixtureHome}'; unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_API_KEY MISTRAL_API_KEY GEMINI_API_KEY GOOGLE_API_KEY; `,
);
try {
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "packages/connections/src/remote.integration.test.ts",
      "packages/cli/src/hosts-remote.test.tsx",
      "--no-file-parallelism",
    ],
    {
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        HARNESS_HOME: home,
        HARNESS_REMOTE_FIXTURE_HOME: fixtureHome,
        // This scenario selects no credential backend; it never probes the account's vault.
        HARNESS_REMOTE_SSH_CONFIG: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENCODE_API_KEY: "",
        MISTRAL_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
      },
    },
  );
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
} finally {
  await rm(home, { recursive: true, force: true });
}
