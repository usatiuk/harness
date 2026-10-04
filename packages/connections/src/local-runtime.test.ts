import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalHome } from "./local.ts";
import { prepareLocalRuntime } from "./local-runtime.ts";

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
