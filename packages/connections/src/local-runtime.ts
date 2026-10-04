import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalHome, privateRuntimeDirectory } from "./local.ts";
import type { ServerLaunch } from "./connect.ts";

/** A persistent packaged server never executes files subsequently replaced by an app update. */
export async function prepareLocalRuntime(
  payload: string,
  requestedHome: string,
): Promise<{ home: string; launch: ServerLaunch }> {
  const home = await canonicalHome(requestedHome);
  const base = join(await privateRuntimeDirectory(home), "runtime");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const names = ["server.mjs", "worker.mjs", "package.json", "package-lock.json"];
  const bytes = await Promise.all(names.map((name) => readFile(join(payload, name))));
  const digest = (...values: Array<string | Buffer>) => {
    const hash = createHash("sha256");
    for (const value of values) hash.update(value);
    return hash.digest("hex");
  };
  const dependencyKey = digest(
    "node_modules\n",
    await readFile(join(payload, "packaged-dependencies.json")),
    process.platform,
    process.arch,
    process.versions.modules,
    process.version,
  );
  const buildId = digest(...bytes, dependencyKey);
  const directory = join(base, buildId);
  const executable = join(
    base,
    `node-${process.version}`,
    process.platform === "win32" ? "node.exe" : "node",
  );
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const release = await lockfile.lock(join(base, "install"), {
    realpath: false,
    retries: { retries: 40, factor: 1, minTimeout: 100, maxTimeout: 250 },
  });
  const staging = join(base, `stage-${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    if (!(await exists(executable))) {
      await mkdir(join(staging, "node"));
      await cp(
        process.execPath,
        join(staging, "node", process.platform === "win32" ? "node.exe" : "node"),
      );
      await rename(join(staging, "node"), join(base, `node-${process.version}`));
    }
    const dependencyCache = join(base, `dependencies-${dependencyKey}`);
    const dependencies = join(dependencyCache, "node_modules");
    if (!(await exists(dependencyCache))) {
      // Node follows the code junction to this real path. Sibling dependencies
      // must remain inside a directory named node_modules to resolve correctly.
      await cp(join(payload, "node_modules"), join(staging, "dependencies", "node_modules"), {
        recursive: true,
      });
      await rename(join(staging, "dependencies"), dependencyCache);
    }
    if (!(await exists(directory))) {
      const code = join(staging, "code");
      await mkdir(code);
      await Promise.all(names.map((name, index) => writeFile(join(code, name), bytes[index]!)));
      // A junction works without Windows symlink privileges and points at our immutable cache.
      await symlink(
        dependencies,
        join(code, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await rename(code, directory);
    }
  } finally {
    try {
      await rm(staging, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
  return {
    home,
    launch: {
      executable,
      args: [join(directory, "server.mjs"), "--background"],
      env: { HARNESS_BUILD_ID: buildId },
    },
  };
}
