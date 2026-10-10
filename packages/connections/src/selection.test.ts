import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, onTestFailed } from "vitest";
import { assertSelectedServer, selectInitialServer, serverCacheEntrySchema } from "./selection.ts";
import { withServerLifecycle } from "./lifecycle.ts";
import { canonicalHome } from "./local.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home(): Promise<string> {
  const value = await canonicalHome(join(tmpdir(), `harness-selection-${randomUUID()}`));
  directories.push(value);
  return value;
}

it("rejects an older initial selection without overwriting the selected build", async () => {
  const started = performance.now();
  const phases: { phase: string; ms: number }[] = [];
  const phase = (phase: string) => phases.push({ phase, ms: performance.now() - started });
  onTestFailed(() => console.error(JSON.stringify({ event: "selection.test", phases })));
  phase("prepare-home");
  const directory = await home();
  phase("home-prepared");
  const selected = "0.2.0-windows-x64";
  await withServerLifecycle(directory, (canonical) => selectInitialServer(canonical, selected));
  phase("newer-build-selected");
  const path = join(directory, "server", "current.json");
  const original = await readFile(path);
  await expect(
    withServerLifecycle(directory, (canonical) =>
      selectInitialServer(canonical, "0.1.0-windows-x64"),
    ),
  ).rejects.toThrow("Selected server changed");
  phase("older-start-rejected");
  expect(await readFile(path)).toEqual(original);
  expect(() => assertSelectedServer(directory, selected)).not.toThrow();
  expect(() => assertSelectedServer(directory, "0.1.0-windows-x64")).toThrow("no longer selected");
  expect(() => assertSelectedServer(directory)).toThrow("no longer selected");
}, 30_000);

it("rejects an unknown selection format without resetting it", async () => {
  const directory = await home();
  await mkdir(join(directory, "server"));
  const path = join(directory, "server", "current.json");
  const original = JSON.stringify({ formatVersion: 2, directory: "0.1.0-windows-x64" });
  await writeFile(path, original);
  await expect(
    withServerLifecycle(directory, (canonical) =>
      selectInitialServer(canonical, "0.1.0-windows-x64"),
    ),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(() => assertSelectedServer(directory, "0.1.0-windows-x64")).toThrow();
}, 30_000);

it("selects a rebuilt source payload without crossing the release or target boundary", async () => {
  const directory = await home();
  const original = `dev-windows-x64-${"a".repeat(64)}`;
  const rebuilt = `dev-windows-x64-${"b".repeat(64)}`;
  await withServerLifecycle(directory, (canonical) => selectInitialServer(canonical, original));
  await withServerLifecycle(directory, (canonical) => selectInitialServer(canonical, rebuilt));
  expect(() => assertSelectedServer(directory, rebuilt)).not.toThrow();
  expect(() => assertSelectedServer(directory, original)).toThrow("no longer selected");
  for (const candidate of ["0.1.0-windows-x64", `dev-linux-x64-glibc-${"c".repeat(64)}`]) {
    await expect(
      withServerLifecycle(directory, (canonical) => selectInitialServer(canonical, candidate)),
    ).rejects.toThrow("Selected server changed");
    expect(() => assertSelectedServer(directory, rebuilt)).not.toThrow();
  }
}, 30_000);

it("accepts immutable release/source names and rejects paths", () => {
  expect(serverCacheEntrySchema.parse("0.1.0-rc.1-linux-x64-glibc")).toBe(
    "0.1.0-rc.1-linux-x64-glibc",
  );
  expect(serverCacheEntrySchema.parse(`dev-macos-arm64-${"a".repeat(64)}`)).toContain(
    "dev-macos-arm64-",
  );
  for (const value of [
    "../0.1.0-windows-x64",
    "/absolute",
    "0.1.0-windows-x64/server.mjs",
    "0.1.0-other",
    "01.1.0-windows-x64",
  ])
    expect(serverCacheEntrySchema.safeParse(value).success).toBe(false);
});
