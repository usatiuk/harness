import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseProjectDoc, parseSettingsDoc, profileDocSchema } from "./settings.ts";
import { resolveSettings } from "./resolve.ts";
import {
  readGlobalInstructions,
  readGlobalSettings,
  updateGlobalInstructions,
  updateGlobalSettings,
} from "./write.ts";

const failures = vi.hoisted(() => ({ rename: false, read: false, write: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (failures.rename) throw Object.assign(new Error("rename denied"), { code: "EACCES" });
      return fs.rename(...args);
    },
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (failures.read) throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return fs.readFile(...args);
    },
    writeFile: (...args: Parameters<typeof fs.writeFile>) => {
      if (failures.write) throw Object.assign(new Error("write denied"), { code: "EACCES" });
      return fs.writeFile(...args);
    },
  };
});
const homes: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), "harness-host-settings-"));
  homes.push(path);
  return path;
}
afterEach(async () => {
  failures.rename = failures.read = failures.write = false;
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("accepts desktop only globally and excludes it from resolved conversation config", async () => {
  expect(parseSettingsDoc({ desktop: { keepServerRunning: true } }, "global").desktop).toEqual({
    keepServerRunning: true,
  });
  for (const desktop of [{ keepServerRunning: "true" }, { typo: true }])
    expect(() => parseSettingsDoc({ desktop }, "global")).toThrow();
  expect(() => parseProjectDoc({ desktop: { keepServerRunning: true } }, "project")).toThrow();
  expect(() => profileDocSchema.parse({ desktop: { keepServerRunning: true } })).toThrow();
  expect(() =>
    parseSettingsDoc({ profiles: { p: { desktop: { keepServerRunning: true } } } }, "global"),
  ).toThrow();
  const h = await home();
  await updateGlobalSettings(h, () => ({
    model: { provider: "demo", model: "demo-1" },
    instructions: "JSON guidance",
    desktop: { keepServerRunning: true },
  }));
  const options = { home: h, schemas: new Map() };
  expect(await resolveSettings(options)).not.toHaveProperty("desktop");
  await expect(
    resolveSettings({ ...options, overrides: { desktop: { keepServerRunning: true } } }),
  ).rejects.toThrow("invalid overrides");
  for (const value of [false, true]) {
    await updateGlobalSettings(h, (doc) => ({ ...doc, desktop: { keepServerRunning: value } }));
    expect(await readGlobalSettings(h)).toMatchObject({
      instructions: "JSON guidance",
      desktop: { keepServerRunning: value },
    });
  }
});

it("distinguishes missing/empty text and saves exact Unicode CRLF without touching settings or another home", async () => {
  const h = await home();
  const other = await home();
  expect(await readGlobalInstructions(h)).toEqual({ path: join(h, "AGENTS.md"), content: null });
  await updateGlobalSettings(h, () => ({ instructions: "JSON stays separate" }));
  const before = await readFile(join(h, "settings.json"), "utf8");
  for (const content of ["", "  λ 日本語\r\n\r\nlast\n\n", "x".repeat(1024 * 1024 + 1)]) {
    await updateGlobalInstructions(h, content);
    expect(await readGlobalInstructions(h)).toEqual({ path: join(h, "AGENTS.md"), content });
    expect(await readFile(join(h, "AGENTS.md"), "utf8")).toBe(content);
  }
  expect(await readFile(join(h, "settings.json"), "utf8")).toBe(before);
  expect((await readGlobalInstructions(other)).content).toBeNull();
});

it.skipIf(process.platform === "win32")(
  "creates privately and retains existing permissions",
  async () => {
    const h = await home();
    const path = join(h, "AGENTS.md");
    await updateGlobalInstructions(h, "new");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o640);
    await updateGlobalInstructions(h, "replacement");
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  },
);

it("rejects symlinks and nonregular instruction targets without changing them", async () => {
  const h = await home();
  const path = join(h, "AGENTS.md");
  const target = join(h, "target");
  await writeFile(target, "original");
  await symlink(target, path);
  await expect(readGlobalInstructions(h)).rejects.toThrow("regular file");
  await expect(updateGlobalInstructions(h, "overwrite")).rejects.toThrow("regular file");
  expect(await readFile(target, "utf8")).toBe("original");
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  await rm(path);
  await mkdir(path);
  await expect(readGlobalInstructions(h)).rejects.toThrow("regular file");
  await expect(updateGlobalInstructions(h, "overwrite")).rejects.toThrow("regular file");
  expect((await lstat(path)).isDirectory()).toBe(true);
});

it.each(["write", "rename"] as const)(
  "preserves original and cleans temporary files after %s failure",
  async (failure) => {
    const h = await home();
    await updateGlobalInstructions(h, "original\r\n");
    failures[failure] = true;
    await expect(updateGlobalInstructions(h, "lost")).rejects.toThrow("EACCES");
    failures[failure] = false;
    expect((await readGlobalInstructions(h)).content).toBe("original\r\n");
    expect(await readdir(h)).toEqual(["AGENTS.md"]);
    await updateGlobalInstructions(h, "retry");
    expect((await readGlobalInstructions(h)).content).toBe("retry");
  },
);

it("propagates read failures rather than reporting missing content", async () => {
  const h = await home();
  await updateGlobalInstructions(h, "original");
  failures.read = true;
  await expect(readGlobalInstructions(h)).rejects.toThrow("EACCES");
});
