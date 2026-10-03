import { build } from "esbuild";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const RUNTIME_EXTERNAL = [
  "better-sqlite3",
  "@napi-rs/keyring",
  "@primno/dpapi",
  "@devcontainers/cli",
  "quickjs-emscripten",
];

/** Local source becomes a portable JS payload; native packages are installed on the target. */
export async function bundleServer(output) {
  await mkdir(output, { recursive: true });
  const external = RUNTIME_EXTERNAL;
  await build({
    entryPoints: [join(root, "packages/server/src/bin.ts")],
    outfile: join(output, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["development"],
    external,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: [join(root, "packages/code-mode/src/worker.mjs")],
    outfile: join(output, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external,
  });
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const dependencies = Object.fromEntries(
    external
      .filter((name) => name !== "@primno/dpapi")
      .map((name) => {
        const entry = lock.packages[`node_modules/${name}`];
        if (!entry?.version) throw new Error(`Missing runtime dependency ${name}`);
        return [name, entry.version];
      }),
  );
  const manifest = {
    name: "harness-server-runtime",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  };
  const metadata = join(output, "metadata");
  await mkdir(metadata, { recursive: true });
  await writeFile(join(metadata, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  // npm produces a complete lock including target-selectable optional dependencies.
  const npm =
    process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await promisify(execFile)(
    process.execPath,
    [npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: metadata, windowsHide: true },
  );
  await cp(join(metadata, "package.json"), join(output, "package.json"));
  await cp(join(metadata, "package-lock.json"), join(output, "package-lock.json"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Expected payload output directory");
  await bundleServer(resolve(process.argv[2]));
}
