import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { nativeTarget } from "./native-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const product = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pin = JSON.parse(await readFile(join(root, "release/node.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const external = [
  "better-sqlite3",
  "@napi-rs/keyring",
  "@primno/dpapi",
  "@devcontainers/cli",
  "quickjs-emscripten",
];
const run = (command, args, env = {}) =>
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
async function describe(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function packageDirectory(name, from) {
  for (const base of createRequire(join(from, "package.json")).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(base, name);
    try {
      await readFile(join(path, "package.json"));
      return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error(`Cannot resolve runtime dependency ${name}`), {
    code: "MODULE_NOT_FOUND",
  });
}

// Preserve npm's actual nested installation: native modules and Ink/Yoga assets
// cannot be flattened or completely bundled into JavaScript.
async function copyDependencies(output, roots) {
  const copied = new Set();
  async function copy(name, from, optional = false) {
    let source;
    try {
      source = await packageDirectory(name, from);
    } catch (error) {
      if (optional && error.code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    if (copied.has(source)) return;
    const path = relative(root, source).split(sep).join("/");
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (
      !path.startsWith("node_modules/") ||
      path.includes("../") ||
      lock.packages[path]?.version !== manifest.version
    )
      throw new Error(`Runtime dependency differs from package-lock.json: ${path}`);
    copied.add(source);
    await cp(source, join(output, path), { recursive: true, verbatimSymlinks: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copy(dependency, source);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      await copy(dependency, source, true);
    for (const peer of Object.keys(manifest.peerDependencies ?? {}))
      await copy(peer, source, manifest.peerDependenciesMeta?.[peer]?.optional);
  }
  for (const name of roots) await copy(name, root);
}

export async function buildIdentity(mode = "development") {
  if (!["development", "release"].includes(mode)) throw new Error("Unknown build mode");
  return {
    mode,
    productVersion: product.version,
    target: nativeTarget().release,
    nodeVersion: pin.version,
  };
}

export async function buildPayload(component, output, identity) {
  if (!["server", "cli"].includes(component)) throw new Error("Unknown payload component");
  if (process.versions.node !== pin.version)
    throw new Error(`Payload builds require Node ${pin.version} (see .nvmrc)`);
  output = resolve(output);
  const base = join(root, "release/output");
  if (!output.startsWith(`${base}${sep}`) && output !== join(root, "packages/desktop/resources"))
    throw new Error("Payload output must be generated build scratch");
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, ".build-"));
  const stage = join(scratch, component);
  await mkdir(stage);
  try {
    const target = nativeTarget();
    const extras = component === "cli" ? ["ink", "react"] : [];
    const dependencies = [...external, ...extras];
    const filename = `${component}.mjs`;
    await build({
      entryPoints: [join(root, `packages/${component}/src/bin.ts`)],
      outfile: join(stage, filename),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      conditions: ["development"],
      external: [...dependencies, "@harness/native"],
      define: { __HARNESS_BUILD__: JSON.stringify(identity) },
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    });
    await cp(join(root, "packages/code-mode/src/worker.mjs"), join(stage, "worker.mjs"));
    await copyDependencies(stage, dependencies);
    const native = join(stage, "node_modules/@harness/native");
    await mkdir(native, { recursive: true });
    for (const name of ["package.json", "index.cjs", "index.d.ts"])
      await cp(join(root, "packages/native", name), join(native, name));
    const profile = identity.mode === "release" ? "release" : "debug";
    const cargoOutput = join(root, "native/target/payloads");
    run(
      "cargo",
      [
        "build",
        "--locked",
        "--manifest-path",
        join(root, "native/Cargo.toml"),
        "--target",
        target.rust,
        "--target-dir",
        cargoOutput,
        "-p",
        "harness-native",
        ...(component === "server" ? ["-p", "harness-launcher"] : []),
        ...(profile === "release" ? ["--release"] : []),
      ],
      {
        HARNESS_RELEASE_BUILD: identity.mode === "release" ? "1" : "0",
      },
    );
    await cp(
      join(cargoOutput, target.rust, profile, target.library),
      join(native, "harness-native.node"),
    );
    if (component === "server") {
      const suffix = process.platform === "win32" ? ".exe" : "";
      await cp(
        join(cargoOutput, target.rust, profile, `harness${suffix}`),
        join(stage, `harness-bootstrap${suffix}`),
      );
    }
    await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
    await writeFile(join(stage, "build.json"), JSON.stringify(identity));
    if (component === "server" && identity.mode === "development") {
      const archive = join(scratch, "server.tar.gz");
      run("tar", ["-czf", archive, "-C", scratch, "server"]);
      await writeFile(join(stage, "server.tar.gz.sha256"), `${(await describe(archive)).sha256}\n`);
      await rename(archive, join(stage, "server.tar.gz"));
    }
    await mkdir(resolve(output, ".."), { recursive: true });
    // These are disposable build outputs; managed installations copy immutable bytes.
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = await buildIdentity(
    process.argv.includes("--release") ? "release" : "development",
  );
  const output = join(root, "release/output", identity.target);
  const remote = process.argv.includes("--remote");
  if (remote && (identity.target !== "linux-x64-glibc" || identity.mode !== "development"))
    throw new Error("Prepare remote source payloads on Linux x64 in development mode");
  for (const component of identity.mode === "release" ? ["server", "cli"] : ["server"])
    await buildPayload(component, join(output, component), identity);
  if (remote) {
    await cp(join(output, "server/server.tar.gz"), join(output, "server.tar.gz"));
    await cp(join(output, "server/harness-bootstrap"), join(output, "harness-bootstrap"));
    await writeFile(
      join(output, "remote.json"),
      JSON.stringify({
        formatVersion: 1,
        target: identity.target,
        productVersion: identity.productVersion,
        nodeVersion: identity.nodeVersion,
        server: await describe(join(output, "server.tar.gz")),
        bootstrap: await describe(join(output, "harness-bootstrap")),
      }),
    );
  }
}
