import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

describe("harness CLI e2e", () => {
  test("runs a fake-model conversation through the source CLI with isolated storage", async () => {
    const harnessHome = await mkdtemp(path.join(tmpdir(), "harness-cli-e2e-"));

    const exec = await runHarness(["exec", "--profile", "fake", "hello"], harnessHome);
    expect(exec.stdout).toContain("echo: hello");

    const list = await runHarness(["conversation", "list"], harnessHome);
    expect(list.stdout).toContain("idle");
    expect(list.stdout).toContain("hello");
  }, 15000);
});

async function runHarness(args: string[], harnessHome: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxBin, ["--conditions=development", "apps/cli/src/bin.ts", ...args], {
    cwd: root,
    timeout: 10000,
    env: {
      ...process.env,
      HARNESS_HOME: harnessHome,
      HARNESS_DB_PATH: path.join(harnessHome, "harness.sqlite")
    }
  });
}
