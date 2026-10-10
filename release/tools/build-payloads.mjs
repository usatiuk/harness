import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { RUNTIME_EXTERNAL } from "./runtime-external.mjs";
import { nativeTarget } from "../../scripts/native-target.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const product = JSON.parse(await readFile(join(root, "release/product.json"), "utf8"));
const pin = JSON.parse(await readFile(join(root, "release/node.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));

export function currentTarget() {
  return nativeTarget().release;
}

async function packageDirectory(name, from) {
  // Node supplies the lookup directories. Read metadata directly: type-only
  // packages and packages hiding package.json need not expose a runtime entry.
  const lookup = createRequire(join(from, "package.json")).resolve.paths(`${name}/package.json`);
  if (lookup === null) throw new Error(`Expected a package dependency: ${name}`);
  for (const base of lookup) {
    const candidate = join(base, name);
    try {
      await readFile(join(candidate, "package.json"));
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error(`Cannot resolve dependency ${name}`), { code: "MODULE_NOT_FOUND" });
}

/** Preserve the frozen npm installation topology, including nested versions. */
export async function copyRuntimeClosure(output, roots = RUNTIME_EXTERNAL) {
  const copied = new Set();
  const packages = {};
  async function copyPackage(name, from) {
    const source = await packageDirectory(name, from);
    if (copied.has(source)) return;
    const key = relative(root, source).split(sep).join("/");
    if (!key.startsWith("node_modules/") || key.includes("../"))
      throw new Error(`Runtime dependency is outside the committed installation: ${name}`);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (lock.packages[key]?.version !== manifest.version)
      throw new Error(`Installed dependency differs from package-lock.json: ${key}`);
    copied.add(source);
    packages[key] = {
      name: manifest.name,
      version: manifest.version,
      integrity: lock.packages[key].integrity,
    };
    await cp(source, join(output, key), { recursive: true, verbatimSymlinks: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyPackage(dependency, source);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try {
        await packageDirectory(dependency, source);
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND") continue;
        throw error;
      }
      await copyPackage(dependency, source);
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      try {
        await packageDirectory(peer, source);
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND" && manifest.peerDependenciesMeta?.[peer]?.optional)
          continue;
        throw error;
      }
      await copyPackage(peer, source);
    }
  }
  for (const name of roots) await copyPackage(name, root);
  return packages;
}

async function buildPayloadContents(component, output, identity) {
  if (!["server", "cli"].includes(component)) throw new Error("Unknown payload component");
  if (process.versions.node !== pin.version)
    throw new Error(
      `Payload builds require managed Node ${pin.version}; run through the development bootstrap`,
    );
  const nativeDatabase = createRequire(import.meta.url)("better-sqlite3");
  const database = new nativeDatabase(":memory:");
  database.close();
  await mkdir(output, { recursive: true });
  const filename = component === "server" ? "server.mjs" : "cli.mjs";
  // Ink's optional devtools and Yoga assets need package context. React must stay
  // beside it as one shared instance rather than a second copy inside the bundle.
  const external =
    component === "cli"
      ? [...RUNTIME_EXTERNAL, "@harness/native", "ink", "react"]
      : [...RUNTIME_EXTERNAL, "@harness/native"];
  await build({
    entryPoints: [join(root, `packages/${component}/src/bin.ts`)],
    outfile: join(output, filename),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["development"],
    external,
    define: { __HARNESS_BUILD__: JSON.stringify(identity) },
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
    external: RUNTIME_EXTERNAL,
  });
  const packages = await copyRuntimeClosure(
    output,
    external.filter((name) => name !== "@harness/native"),
  );
  const native = join(output, "node_modules/@harness/native");
  await mkdir(native, { recursive: true });
  for (const name of ["package.json", "index.cjs", "index.d.ts"])
    await cp(join(root, "packages/native", name), join(native, name));
  const profile = identity.mode === "release" ? "release" : "debug";
  const target = nativeTarget();
  // The source bootstrap is waiting for this build. Windows cannot replace its
  // running executable; payload outputs have their own build scratch.
  const nativeOutput = join(root, "native/target/payloads");
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      join(root, "native/Cargo.toml"),
      "--target",
      target.rust,
      "--target-dir",
      nativeOutput,
      "-p",
      "harness-native",
      ...(component === "server" ? ["-p", "harness-launcher"] : []),
      ...(profile === "release" ? ["--release"] : []),
    ],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        HARNESS_SOURCE_COMMIT: identity.sourceCommit,
        HARNESS_RELEASE_BUILD: identity.mode === "release" ? "1" : "0",
      },
    },
  );
  await cp(
    join(nativeOutput, target.rust, profile, target.library),
    join(native, "harness-native.node"),
  );
  if (component === "server") {
    const suffix = process.platform === "win32" ? ".exe" : "";
    await cp(
      join(nativeOutput, target.rust, profile, `harness${suffix}`),
      join(output, `harness-bootstrap${suffix}`),
    );
  }
  await cp(join(root, "LICENSE"), join(native, "LICENSE"));
  packages["node_modules/@harness/native"] = { name: "@harness/native", version: product.version };
  await writeFile(join(output, "packaged-dependencies.json"), `${JSON.stringify(packages)}\n`);
  await writeFile(
    join(output, "package.json"),
    `${JSON.stringify(
      {
        name: `harness-${component}-payload`,
        version: product.version,
        private: true,
        type: "module",
        license: product.license,
      },
      null,
      2,
    )}\n`,
  );
  // Retain the committed graph as evidence; managed targets never run npm install.
  await cp(join(root, "package-lock.json"), join(output, "package-lock.json"));
  await cp(join(root, "LICENSE"), join(output, "LICENSE"));
  await writeFile(join(output, "build.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const notices = Object.entries(packages).map(
    ([path, entry]) => `${path}: ${entry.name}@${entry.version}`,
  );
  await writeFile(
    join(output, "DEPENDENCIES.txt"),
    `${notices.join("\n")}\nDependency license files are included beside each package.\n`,
  );
}

export async function buildPayload(component, output, identity) {
  output = resolve(output);
  const base = resolve(root, "release/output");
  if (!output.startsWith(`${base}${sep}`) && output !== resolve(root, "packages/desktop/resources"))
    throw new Error("Payload output must be release scratch or generated desktop resources");
  await mkdir(base, { recursive: true });
  const stage = await mkdtemp(join(base, ".build-"));
  try {
    await buildPayloadContents(component, stage, identity);
    await mkdir(resolve(output, ".."), { recursive: true });
    // Release output is reproducible build scratch, never a managed installation.
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function buildIdentity(mode = "development") {
  if (!["development", "release"].includes(mode)) throw new Error("Unknown build mode");
  // A source copy built on another OS carries the checkout's captured commit.
  // Public releases still prove identity and cleanliness from the checkout.
  const sourceCommit =
    (mode === "development" && process.env.HARNESS_SOURCE_COMMIT) ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("Invalid captured source commit");
  if (
    mode === "release" &&
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim()
  )
    throw new Error("Release payloads require a clean source commit");
  const target = currentTarget();
  return {
    mode,
    productVersion: product.version,
    sourceCommit,
    target,
    nodeVersion: pin.version,
    releaseManifestUrl:
      mode === "release"
        ? `https://github.com/${product.repository}/releases/download/v${product.version}/release.json`
        : null,
    releaseVerificationPublicKey:
      mode === "release"
        ? (await readFile(join(root, "release/verification-key.pub"), "utf8")).trim()
        : null,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = await buildIdentity(
    process.argv.includes("--release") ? "release" : "development",
  );
  const target = identity.target;
  const output = join(root, "release/output", target);
  for (const component of process.argv.includes("--server-only") ? ["server"] : ["server", "cli"]) {
    await buildPayload(component, join(output, component), identity);
    process.stderr.write(`Built ${component} ${product.version} for ${target}\n`);
  }
}
