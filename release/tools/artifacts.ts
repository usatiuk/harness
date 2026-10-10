import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  artifactSchema,
  MANAGEMENT_VERSION,
  NODE_PIN,
  PRODUCT_VERSION,
  RELEASE_REPOSITORY,
  releaseManifestSchema,
  targetSchema,
  versionSchema,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseTarget,
} from "@harness/release";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval/client";
import { MCP_CLIENT_CONTRACT_VERSION } from "@harness/mcp/client";
import { STORE_SCHEMA_VERSION } from "../../packages/store-sqlite/src/schema.ts";
import { verifyArtifactSignature } from "@harness/native";
import { cleanSourceCommit, repositoryRoot } from "./version.ts";

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const identitySchema = z.strictObject({
  mode: z.literal("release"),
  productVersion: versionSchema,
  sourceCommit: commitSchema,
  target: targetSchema,
  nodeVersion: versionSchema,
  releaseManifestUrl: z.url(),
  releaseVerificationPublicKey: z.string().min(1),
});
type Identity = z.infer<typeof identitySchema>;
const targetContentsSchema = releaseManifestSchema.shape.targets.valueType;
const fileRecordSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  size: artifactSchema.shape.size,
  sha256: artifactSchema.shape.sha256,
});
const desktopBuildSchema = z.strictObject({
  identity: identitySchema,
  executable: fileRecordSchema,
  installer: fileRecordSchema,
  update: fileRecordSchema.extend({ signature: z.string().min(1) }),
});
const bundleSchema = z.strictObject({
  identity: identitySchema,
  contents: targetContentsSchema,
  desktopBuild: desktopBuildSchema,
});
const updaterTargets: Record<ReleaseTarget, string> = {
  "windows-x64": "windows-x86_64",
  "linux-x64-glibc": "linux-x86_64",
  "macos-arm64": "darwin-aarch64",
  "macos-x64": "darwin-x86_64",
};

export function updaterMetadata(manifest: ReleaseManifest) {
  return {
    version: manifest.productVersion,
    platforms: Object.fromEntries(
      Object.entries(manifest.targets).map(([target, contents]) => {
        if (!contents.desktopUpdate) throw new Error(`Desktop update missing for ${target}`);
        return [
          updaterTargets[target as ReleaseTarget],
          {
            url: contents.desktopUpdate.artifact.url,
            signature: contents.desktopUpdate.signature,
          },
        ];
      }),
    ),
  };
}

function downloadBase(version: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/`;
}

export async function fileIdentity(path: string): Promise<{ size: number; sha256: string }> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > 2 * 1024 ** 3)
    throw new Error(`Invalid release asset: ${basename(path)}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { size: metadata.size, sha256: hash.digest("hex") };
}

async function describe(
  path: string,
  version: string,
  format: ReleaseArtifact["format"],
  root: string,
  entry: string,
): Promise<ReleaseArtifact> {
  return artifactSchema.parse({
    url: `${downloadBase(version)}${encodeURIComponent(basename(path))}`,
    ...(await fileIdentity(path)),
    format,
    root,
    entry,
  });
}

function validateIdentity(actual: unknown, expected: Identity): Identity {
  const identity = identitySchema.parse(actual);
  for (const key of Object.keys(expected) as (keyof Identity)[])
    if (identity[key] !== expected[key]) throw new Error(`Release build identity differs: ${key}`);
  return identity;
}

export interface PackageTargetOptions {
  payloads: string;
  output: string;
  sourceCommit: string;
  launcher: string;
  nodeArchive: string;
  minimumPlatform: string;
  desktopBuild: string;
}

/** Called only after a fresh, successful Tauri build in private build scratch.
 * Its record binds that one build's installer and update bytes to the probed
 * native executable. Later packaging accepts the record, never arbitrary signed
 * installer paths whose signature says nothing about their release identity. */
export async function recordDesktopBuild(options: {
  executable: string;
  installer: string;
  update: string;
  output: string;
  sourceCommit: string;
}): Promise<void> {
  const identity = identitySchema.parse(
    JSON.parse(
      execFileSync(options.executable, ["--build-info"], { encoding: "utf8", windowsHide: true }),
    ),
  );
  const key = (await readFile(join(repositoryRoot, "release/verification-key.pub"), "utf8")).trim();
  validateIdentity(identity, {
    ...identity,
    productVersion: PRODUCT_VERSION,
    sourceCommit: options.sourceCommit,
    nodeVersion: NODE_PIN.version,
    releaseManifestUrl: `${downloadBase(PRODUCT_VERSION)}release.json`,
    releaseVerificationPublicKey: key,
  });
  const signature = (await readFile(`${options.update}.sig`, "utf8")).trim();
  verifyArtifactSignature(await readFile(options.update), signature);
  await mkdir(options.output);
  let complete = false;
  try {
    const record = async (path: string) => {
      const destination = join(options.output, basename(path));
      await cp(path, destination);
      return { name: basename(path), ...(await fileIdentity(destination)) };
    };
    const executable = await record(options.executable);
    const installer = await record(options.installer);
    const update =
      resolve(options.installer) === resolve(options.update)
        ? { ...installer, signature }
        : { ...(await record(options.update)), signature };
    const build = desktopBuildSchema.parse({ identity, executable, installer, update });
    await writeFile(
      join(options.output, "desktop-build.json"),
      `${JSON.stringify(build, null, 2)}\n`,
      { flag: "wx" },
    );
    complete = true;
  } finally {
    if (!complete) await rm(options.output, { recursive: true, force: true });
  }
}

/** Package already built bytes. Signing and publication happen after the declared
 * matrix has been assembled, never independently in competing platform jobs. */
export async function packageTarget(options: PackageTargetOptions): Promise<void> {
  const identity = identitySchema.parse(
    JSON.parse(await readFile(join(options.payloads, "server/build.json"), "utf8")),
  );
  const publicKey = (
    await readFile(join(repositoryRoot, "release/verification-key.pub"), "utf8")
  ).trim();
  validateIdentity(identity, {
    ...identity,
    productVersion: PRODUCT_VERSION,
    sourceCommit: commitSchema.parse(options.sourceCommit),
    nodeVersion: NODE_PIN.version,
    releaseManifestUrl: `${downloadBase(PRODUCT_VERSION)}release.json`,
    releaseVerificationPublicKey: publicKey,
  });
  validateIdentity(
    JSON.parse(await readFile(join(options.payloads, "cli/build.json"), "utf8")),
    identity,
  );
  const desktopBuild = desktopBuildSchema.parse(
    JSON.parse(await readFile(options.desktopBuild, "utf8")),
  );
  validateIdentity(desktopBuild.identity, identity);
  const desktopDirectory = resolve(options.desktopBuild, "..");
  for (const record of [desktopBuild.executable, desktopBuild.installer, desktopBuild.update]) {
    const actual = await fileIdentity(join(desktopDirectory, record.name));
    if (actual.sha256 !== record.sha256 || actual.size !== record.size)
      throw new Error(`Desktop build output changed: ${record.name}`);
  }
  validateIdentity(
    JSON.parse(
      execFileSync(join(desktopDirectory, desktopBuild.executable.name), ["--build-info"], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ),
    identity,
  );
  const desktop = join(desktopDirectory, desktopBuild.installer.name);
  const desktopUpdate = join(desktopDirectory, desktopBuild.update.name);
  // Query the actual executable, so a stale development/native build cannot be
  // described as a release merely by copying a neighboring JSON file.
  validateIdentity(
    JSON.parse(
      execFileSync(options.launcher, ["--build-info"], { encoding: "utf8", windowsHide: true }),
    ),
    identity,
  );
  const bootstrap = join(
    options.payloads,
    "server",
    identity.target === "windows-x64" ? "harness-bootstrap.exe" : "harness-bootstrap",
  );
  validateIdentity(
    JSON.parse(execFileSync(bootstrap, ["--build-info"], { encoding: "utf8", windowsHide: true })),
    identity,
  );
  const node = NODE_PIN.targets[identity.target];
  const nodeIdentity = await fileIdentity(options.nodeArchive);
  if (nodeIdentity.size !== node.size || nodeIdentity.sha256 !== node.sha256)
    throw new Error("Node archive differs from the committed pin");
  if (!options.minimumPlatform.trim()) throw new Error("A declared minimum platform is required");
  const output = resolve(options.output);
  await mkdir(resolve(output, ".."), { recursive: true });
  await mkdir(output); // Never overwrite an earlier artifact set, even in scratch.
  let complete = false;
  try {
    const artifacts: Partial<Record<"server" | "cli", ReleaseArtifact>> = {};
    for (const component of ["server", "cli"] as const) {
      const archive = join(
        output,
        `harness-${identity.productVersion}-${identity.target}-${component}.tar.gz`,
      );
      execFileSync("tar", ["-czf", archive, "-C", resolve(options.payloads), component], {
        windowsHide: true,
      });
      artifacts[component] = await describe(
        archive,
        identity.productVersion,
        "tarGz",
        component,
        `${component}.mjs`,
      );
    }
    const launcherName = `harness-${identity.productVersion}-${identity.target}${identity.target === "windows-x64" ? ".exe" : ""}`;
    const launcherPath = join(output, launcherName);
    await cp(options.launcher, launcherPath);
    const nodeName = basename(new URL(node.url).pathname);
    const nodePath = join(output, nodeName);
    await cp(options.nodeArchive, nodePath);
    // Runtime-only releases are immutable and never become the product's latest.
    const runtimeUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-node-${NODE_PIN.version}/${nodeName}`;
    const installer = join(
      output,
      `harness-${identity.productVersion}-${identity.target}-desktop${extname(desktop)}`,
    );
    await cp(desktop, installer);
    const update =
      desktopUpdate === desktop
        ? installer
        : join(
            output,
            `harness-${identity.productVersion}-${identity.target}-desktop-update${desktopUpdate.endsWith(".tar.gz") ? ".tar.gz" : extname(desktopUpdate)}`,
          );
    if (update !== installer) await cp(desktopUpdate, update);
    const signature = desktopBuild.update.signature;
    if (!signature) throw new Error("Missing desktop updater signature");
    verifyArtifactSignature(await readFile(update), signature);
    const isMac = identity.target.startsWith("macos-");
    const contents = targetContentsSchema.parse({
      minimumPlatform: options.minimumPlatform,
      node: { version: NODE_PIN.version, artifact: { ...node, url: runtimeUrl } },
      server: artifacts.server,
      cli: artifacts.cli,
      launcher: await describe(
        launcherPath,
        identity.productVersion,
        "file",
        "launcher",
        identity.target === "windows-x64" ? "harness.exe" : "harness",
      ),
      desktop: await describe(
        installer,
        identity.productVersion,
        "file",
        "desktop",
        basename(installer),
      ),
      desktopUpdate: {
        artifact: await describe(
          update,
          identity.productVersion,
          isMac ? "tarGz" : "file",
          isMac ? "Harness.app" : "desktop",
          isMac ? "Contents/MacOS/harness-desktop" : basename(update),
        ),
        signature,
      },
    });
    await writeFile(
      join(output, "target.json"),
      `${JSON.stringify({ identity, contents, desktopBuild }, null, 2)}\n`,
      { flag: "wx" },
    );
    complete = true;
  } finally {
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

async function verifyAsset(directory: string, artifact: ReleaseArtifact): Promise<void> {
  const name = decodeURIComponent(basename(new URL(artifact.url).pathname));
  if (basename(name) !== name || name.includes("\\")) throw new Error("Unsafe release asset name");
  const actual = await fileIdentity(join(directory, name));
  if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
    throw new Error(`Release asset was changed: ${name}`);
}

export async function assembleRelease(
  input: string,
  output: string,
  targets: ReleaseTarget[],
  sourceCommit: string,
): Promise<ReleaseManifest> {
  commitSchema.parse(sourceCommit);
  if (targets.length === 0 || new Set(targets).size !== targets.length)
    throw new Error("Declare each intended release target once");
  const contents: ReleaseManifest["targets"] = {};
  const names = new Map<string, string>();
  const files = new Map<string, string>();
  const publicKey = (
    await readFile(join(repositoryRoot, "release/verification-key.pub"), "utf8")
  ).trim();
  for (const target of targets) {
    targetSchema.parse(target);
    const directory = join(input, target);
    const bundle = bundleSchema.parse(
      JSON.parse(await readFile(join(directory, "target.json"), "utf8")),
    );
    validateIdentity(bundle.identity, {
      mode: "release",
      productVersion: PRODUCT_VERSION,
      sourceCommit,
      target,
      nodeVersion: NODE_PIN.version,
      releaseManifestUrl: `${downloadBase(PRODUCT_VERSION)}release.json`,
      releaseVerificationPublicKey: publicKey,
    });
    if (!bundle.contents.desktop || !bundle.contents.desktopUpdate)
      throw new Error(`Desktop/update assets missing for ${target}`);
    const node = NODE_PIN.targets[target];
    if (
      bundle.contents.node.version !== NODE_PIN.version ||
      bundle.contents.node.artifact.sha256 !== node.sha256 ||
      bundle.contents.node.artifact.size !== node.size
    )
      throw new Error(`Runtime identity differs for ${target}`);
    for (const field of ["format", "root", "entry"] as const)
      if (bundle.contents.node.artifact[field] !== node[field])
        throw new Error(`Runtime layout differs for ${target}: ${field}`);
    if (
      basename(new URL(bundle.contents.node.artifact.url).pathname) !==
      basename(new URL(node.url).pathname)
    )
      throw new Error(`Runtime asset name differs for ${target}`);
    validateIdentity(bundle.desktopBuild.identity, bundle.identity);
    for (const [record, artifact] of [
      [bundle.desktopBuild.installer, bundle.contents.desktop],
      [bundle.desktopBuild.update, bundle.contents.desktopUpdate.artifact],
    ] as const)
      if (record.size !== artifact.size || record.sha256 !== artifact.sha256)
        throw new Error(`Desktop build bytes differ for ${target}`);
    if (bundle.desktopBuild.update.signature !== bundle.contents.desktopUpdate.signature)
      throw new Error(`Desktop build signature differs for ${target}`);
    for (const artifact of [
      bundle.contents.node.artifact,
      bundle.contents.server,
      bundle.contents.cli,
      bundle.contents.launcher,
      bundle.contents.desktop,
      bundle.contents.desktopUpdate.artifact,
    ]) {
      const expectedBase =
        artifact === bundle.contents.node.artifact
          ? `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-node-${NODE_PIN.version}/`
          : downloadBase(PRODUCT_VERSION);
      const name = decodeURIComponent(basename(new URL(artifact.url).pathname));
      if (artifact.url !== `${expectedBase}${encodeURIComponent(name)}`)
        throw new Error("Artifact URL points outside the captured release");
      await verifyAsset(directory, artifact);
      const previous = names.get(name);
      if (previous !== undefined && previous !== artifact.sha256)
        throw new Error(`Conflicting release asset name: ${name}`);
      names.set(name, artifact.sha256);
      files.set(name, join(directory, name));
    }
    verifyArtifactSignature(
      await readFile(
        files.get(
          decodeURIComponent(
            basename(new URL(bundle.contents.desktopUpdate.artifact.url).pathname),
          ),
        )!,
      ),
      bundle.contents.desktopUpdate.signature,
    );
    contents[target] = bundle.contents;
  }
  const actualTargets = (await readdir(input, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name);
  if (actualTargets.some((target) => !targets.includes(target as ReleaseTarget)))
    throw new Error("Input contains an undeclared release target");
  const manifest = releaseManifestSchema.parse({
    formatVersion: 1,
    productVersion: PRODUCT_VERSION,
    sourceCommit,
    managementVersion: MANAGEMENT_VERSION,
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    pluginContracts: Object.fromEntries(
      [
        { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
        { id: "mcp", version: MCP_CLIENT_CONTRACT_VERSION },
        ...FEATURE_PLUGIN_CONTRACTS,
      ].map(({ id, version }) => [id, String(version)]),
    ),
    targets: contents,
  });
  await mkdir(resolve(output, ".."), { recursive: true });
  const temporary = `${resolve(output)}.assembling`;
  await mkdir(temporary);
  try {
    for (const [name, path] of files) {
      await cp(path, join(temporary, name));
      const actual = await fileIdentity(join(temporary, name));
      if (actual.sha256 !== names.get(name))
        throw new Error(`Release asset changed while copying: ${name}`);
    }
    await writeFile(join(temporary, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(temporary, "latest.json"),
      `${JSON.stringify(updaterMetadata(manifest), null, 2)}\n`,
    );
    // Renaming onto an existing non-empty set fails; published assets are never replaced.
    await rename(temporary, resolve(output));
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const sourceCommit = cleanSourceCommit(repositoryRoot);
  if (command === "assemble" && args.length === 3) {
    await assembleRelease(
      args[0]!,
      args[1]!,
      args[2]!.split(",").map((target) => targetSchema.parse(target)),
      sourceCommit,
    );
  } else if (command === "package" && args.length === 6) {
    await packageTarget({
      payloads: args[0]!,
      output: args[1]!,
      launcher: args[2]!,
      nodeArchive: args[3]!,
      minimumPlatform: args[4]!,
      desktopBuild: args[5]!,
      sourceCommit,
    });
  } else {
    throw new Error(
      "Usage: release:artifacts package PAYLOADS OUTPUT LAUNCHER NODE MINIMUM_OS DESKTOP_BUILD | assemble INPUT OUTPUT TARGETS",
    );
  }
}
