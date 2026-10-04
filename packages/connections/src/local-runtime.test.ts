import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalHome } from "./local.ts";
import { prepareLocalRuntime } from "./local-runtime.ts";

it("runs SQLite and its sibling dependencies from an isolated packaged cache", async () => {
  const root = await canonicalHome(join(tmpdir(), `harness-runtime-${randomUUID()}`));
  const payload = join(root, "payload");
  const require = createRequire(import.meta.url);
  const dependencies: Record<string, unknown> = {};
  try {
    await mkdir(payload);
    for (const name of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
      const manifest = require.resolve(`${name}/package.json`);
      dependencies[name] = JSON.parse(await readFile(manifest, "utf8"));
      await cp(dirname(manifest), join(payload, "node_modules", name), { recursive: true });
    }
    await writeFile(join(payload, "packaged-dependencies.json"), JSON.stringify(dependencies));
    await writeFile(join(payload, "package.json"), '{"type":"module"}');
    await writeFile(join(payload, "package-lock.json"), "{}");
    await writeFile(join(payload, "worker.mjs"), "export {};");
    await writeFile(
      join(payload, "server.mjs"),
      'import Database from "better-sqlite3"; const db = new Database(":memory:"); ' +
        'console.log(db.prepare("select 42 as value").get().value); db.close();',
    );
    const runtime = await prepareLocalRuntime(payload, join(root, "home"));
    const execute = () =>
      promisify(execFile)(runtime.launch.executable, runtime.launch.args, {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, NODE_PATH: "" },
      });
    expect((await execute()).stdout.trim()).toBe("42");
    await rm(payload, { recursive: true });
    expect((await execute()).stdout.trim()).toBe("42");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("invalidates the packaged dependency cache when a Windows-only dependency changes", async () => {
  const root = await canonicalHome(join(tmpdir(), `harness-runtime-${randomUUID()}`));
  const payload = join(root, "payload");
  const home = join(root, "home");
  const packagePath = join(payload, "node_modules", "@primno", "dpapi", "package.json");
  await mkdir(dirname(packagePath), { recursive: true });
  for (const name of ["server.mjs", "worker.mjs", "package.json", "package-lock.json"])
    await writeFile(join(payload, name), name);
  const dependencies = async (version: string) => {
    const manifest = { name: "@primno/dpapi", version };
    await writeFile(packagePath, JSON.stringify(manifest));
    await writeFile(
      join(payload, "packaged-dependencies.json"),
      JSON.stringify({ "@primno/dpapi": manifest }),
    );
  };
  try {
    await dependencies("1.0.0");
    const first = await prepareLocalRuntime(payload, home);
    await dependencies("2.0.0");
    const second = await prepareLocalRuntime(payload, home);
    expect(second.launch.args[0]).not.toBe(first.launch.args[0]);
    const installed = (runtime: typeof first) =>
      readFile(
        join(dirname(runtime.launch.args[0]!), "node_modules", "@primno", "dpapi", "package.json"),
        "utf8",
      ).then((text) => JSON.parse(text) as { version: string });
    expect(await installed(first)).toMatchObject({ version: "1.0.0" });
    expect(await installed(second)).toMatchObject({ version: "2.0.0" });
    expect(await prepareLocalRuntime(payload, home)).toEqual(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
