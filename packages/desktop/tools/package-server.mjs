import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../resources/", import.meta.url));
if (resolve(output) !== resolve(root, "packages/desktop/resources"))
  throw new Error("Invalid generated resource directory");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "runtime"), { recursive: true });
await cp(
  process.execPath,
  join(output, "runtime", process.platform === "win32" ? "node.exe" : "node"),
);
let nodeLicense;
try {
  nodeLicense = await readFile(join(dirname(process.execPath), "LICENSE"), "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await globalThis.fetch(
    `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
  );
  if (!response.ok)
    throw new Error(
      `Cannot obtain the license for bundled Node ${process.version}: HTTP ${response.status}`,
      { cause: error },
    );
  nodeLicense = await response.text();
}
await writeFile(join(output, "runtime", "LICENSE"), nodeLicense);
const external = [
  "better-sqlite3",
  "@napi-rs/keyring",
  "@primno/dpapi",
  "@devcontainers/cli",
  "quickjs-emscripten",
];
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
const copied = new Set();
async function copyPackage(name, from) {
  if (copied.has(name)) return;
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`, { paths: [from] });
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = dirname(require.resolve(name, { paths: [from] }));
    while (true) {
      try {
        const json = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (json.name === name) {
          manifest = join(directory, "package.json");
          break;
        }
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`Cannot locate native dependency ${name}`, { cause: error });
      directory = parent;
    }
  }
  const source = dirname(manifest);
  const json = JSON.parse(await readFile(manifest, "utf8"));
  copied.add(name);
  await cp(source, join(output, "node_modules", name), { recursive: true });
  for (const dependency of Object.keys(json.dependencies ?? {}))
    await copyPackage(dependency, source);
  for (const dependency of Object.keys(json.optionalDependencies ?? {})) {
    try {
      require.resolve(dependency, { paths: [source] });
    } catch (error) {
      if (error.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    await copyPackage(dependency, source);
  }
}
for (const name of external) await copyPackage(name, root);
await writeFile(
  join(output, "package.json"),
  JSON.stringify({ private: true, type: "module" }) + "\n",
);
console.log(
  `Packaged Node ${process.version}, Harness server and ${copied.size} native/runtime dependencies.`,
);
