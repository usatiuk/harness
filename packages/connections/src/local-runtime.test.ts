import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalHome } from "./local.ts";
import { prepareLocalRuntime, preparedServerSchema } from "./local-runtime.ts";

it("executes the captured Node and complete SQLite payload without another cache", async () => {
  const root = await canonicalHome(join(tmpdir(), `harness-prepared-runtime-${randomUUID()}`));
  const home = await canonicalHome(join(root, "home"));
  const target =
    process.platform === "win32"
      ? "windows-x64"
      : process.platform === "darwin"
        ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
        : `linux-${process.arch === "arm64" ? "arm64" : "x64"}-glibc`;
  const payload = join(home, "server", `0.1.0-${target}`);
  // Native preparation captures an executable in place. Relocating a Homebrew
  // binary breaks its relative libnode linkage and is not this consumer's contract.
  const node = process.execPath;
  const require = createRequire(import.meta.url);
  let usage: { close(): void } | undefined;
  try {
    await mkdir(payload, { recursive: true });
    for (const name of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
      const manifest = require.resolve(`${name}/package.json`);
      await cp(dirname(manifest), join(payload, "node_modules", name), { recursive: true });
    }
    await writeFile(join(payload, "package.json"), '{"type":"module"}');
    const entry = join(payload, "server.mjs");
    await writeFile(
      entry,
      'import Database from "better-sqlite3"; const db = new Database(":memory:"); ' +
        'console.log(JSON.stringify({node:process.execPath,value:db.prepare("select 42 as value").get().value})); db.close();',
    );
    const descriptor = preparedServerSchema.parse({
      node,
      entry,
      payload,
    });
    const runtime = await prepareLocalRuntime(descriptor, home);
    expect(runtime.launch.executable).toBe(node);
    usage = runtime.launch.retainUse?.();
    const result = await promisify(execFile)(runtime.launch.executable, runtime.launch.args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ...runtime.launch.env, NODE_PATH: "" },
    });
    expect(JSON.parse(result.stdout)).toEqual({ node, value: 42 });
    expect(runtime.launch.selection).toBe(`0.1.0-${target}`);
    expect(runtime.launch.args[0]).toBe(entry);
    expect(await readdir(home)).not.toContain(".running-server");
    expect(await readFile(entry, "utf8")).toContain("select 42");
  } finally {
    usage?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("rejects malformed native descriptors at the shared boundary", () => {
  expect(() =>
    preparedServerSchema.parse({
      entry: "server",
      payload: "payload",
    }),
  ).toThrow();
  expect(() =>
    preparedServerSchema.parse({
      node: "",
      entry: "server",
      payload: "payload",
    }),
  ).toThrow();
});
