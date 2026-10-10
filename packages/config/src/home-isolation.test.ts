import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => account.home,
}));
import { findProjectRoot, isHomeRoot, loadMergedSettings } from "./resolve.ts";

let temporary: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("keeps account-global settings outside the project cascade with an isolated development home", async () => {
  temporary = await mkdtemp(join(tmpdir(), "harness-home-isolation-"));
  account.home = join(temporary, "account");
  const ordinaryHome = join(account.home, ".harness");
  const workspace = join(account.home, "workspace");
  const developmentHome = join(workspace, ".harness-dev");
  await mkdir(ordinaryHome, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    join(ordinaryHome, "settings.json"),
    JSON.stringify({ version: 1, instructions: "must not leak" }),
  );
  vi.stubEnv("HARNESS_HOME", developmentHome);
  expect(await findProjectRoot(workspace, developmentHome)).toBe(workspace);
  expect(await loadMergedSettings(developmentHome, workspace)).toEqual({});
  expect(await isHomeRoot(account.home, developmentHome)).toBe(true);
});
