import { execFileSync } from "node:child_process";
import { cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NODE_PIN,
  PRODUCT_VERSION,
  RELEASE_REPOSITORY,
  releaseManifestSchema,
  targetSchema,
  type ReleaseManifest,
} from "@harness/release";
import { verifyArtifactSignature, verifyRelease } from "@harness/native";
import { assembleRelease, fileIdentity, updaterMetadata } from "./artifacts.ts";
import { cleanSourceCommit, repositoryRoot } from "./version.ts";
import { publishDraft } from "./publish.ts";

const channelSchema = z.enum(["windows-preview", "stable"]);
const sourceSchema = z.looseObject({
  productVersion: z.string(),
  sourceCommit: z.string(),
  missingNotices: z.array(z.string()),
  npmPreferredSourceComplete: z.boolean(),
});
const nameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/u);

/** Download upstream bytes only in the build job. Users consume the same pin
 * through the native bootstrap. The bounded stream never buffers an archive. */
export async function downloadRuntime(
  url: string,
  size: number,
  sha256: string,
  path: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(`Runtime download failed: HTTP ${response.status}`);
  const file = await open(path, "wx");
  const hash = createHash("sha256");
  let total = 0;
  let complete = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = z.instanceof(Uint8Array).parse(item.value);
      total += chunk.byteLength;
      if (total > size) throw new Error("Runtime download exceeds its committed size");
      hash.update(chunk);
      // FileHandle.write can write fewer bytes than requested.
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten === 0) throw new Error("Runtime download write made no progress");
        offset += bytesWritten;
      }
    }
    if (total !== size || hash.digest("hex") !== sha256)
      throw new Error("Runtime archive differs from the committed pin");
    complete = true;
  } finally {
    try {
      await reader.cancel();
    } finally {
      try {
        await file.close();
      } finally {
        // This file was created exclusively by this attempt in private build
        // scratch. The complete publication set is exposed only after signing.
        if (!complete) await rm(path, { force: true });
      }
    }
  }
}

export async function preparePublication(
  input: string,
  output: string,
  targets: string[],
  source: string,
): Promise<void> {
  const sourceCommit = cleanSourceCommit(repositoryRoot);
  const description = sourceSchema.parse(
    JSON.parse(await readFile(join(source, "source.json"), "utf8")),
  );
  if (description.productVersion !== PRODUCT_VERSION || description.sourceCommit !== sourceCommit)
    throw new Error("Source export differs from the captured release");
  await assembleRelease(
    input,
    output,
    targets.map((target) => targetSchema.parse(target)),
    sourceCommit,
  );
  let complete = false;
  try {
    // Keep upstream runtime publication separate: it must never become product latest.
    const runtime = join(output, "runtime");
    await mkdir(runtime);
    for (const pin of Object.values(NODE_PIN.targets)) {
      const name = nameSchema.parse(basename(new URL(pin.url).pathname));
      const existing = join(output, name);
      const entries = await readdir(output);
      if (entries.includes(name)) {
        const actual = await fileIdentity(existing);
        if (actual.size !== pin.size || actual.sha256 !== pin.sha256)
          throw new Error("Packaged runtime differs from the committed pin");
        await rename(existing, join(runtime, name));
      } else await downloadRuntime(pin.url, pin.size, pin.sha256, join(runtime, name));
    }
    for (const name of [
      `harness-${PRODUCT_VERSION}-source.tar.gz`,
      `harness-${PRODUCT_VERSION}-notices.txt`,
      "source.json",
    ])
      await cp(join(source, name), join(output, name), { errorOnExist: true, force: false });
    complete = true;
  } finally {
    // assembleRelease created this output exclusively; preserve any earlier set
    // when it rejects before returning.
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

async function assetNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === "runtime") continue;
    if (!entry.isFile()) throw new Error("Unexpected publication entry");
    names.push(nameSchema.parse(entry.name));
  }
  return names.sort();
}

async function signFile(path: string): Promise<void> {
  const signaturePath = `${path}.sig`;
  const names = await readdir(resolve(path, ".."));
  if (!names.includes(basename(signaturePath))) {
    // Clap reads key content/path and password from the environment; no secret
    // is put into command arguments or emitted by this wrapper.
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)
      throw new Error("Project signing key is required");
    execFileSync(
      process.execPath,
      [
        join(repositoryRoot, "node_modules/@tauri-apps/cli/tauri.js"),
        "signer",
        "sign",
        "--app-version",
        PRODUCT_VERSION,
        path,
      ],
      {
        windowsHide: true,
        timeout: 120_000,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  }
  verifyArtifactSignature(await readFile(path), (await readFile(signaturePath, "utf8")).trim());
}

async function checksums(directory: string): Promise<string> {
  const names = (await assetNames(directory)).filter(
    (name) => !["checksums.txt", "checksums.txt.sig"].includes(name),
  );
  const lines: string[] = [];
  for (const name of names)
    lines.push(`${(await fileIdentity(join(directory, name))).sha256}  ${name}\n`);
  return lines.join("");
}

async function verifyPublicationFiles(directory: string, manifest: ReleaseManifest): Promise<void> {
  const expected = new Set([
    "release.json",
    "latest.json",
    "source.json",
    `harness-${manifest.productVersion}-source.tar.gz`,
    `harness-${manifest.productVersion}-notices.txt`,
  ]);
  for (const [target, contents] of Object.entries(manifest.targets)) {
    if (!contents.desktop || !contents.desktopUpdate)
      throw new Error(`Desktop assets missing for ${target}`);
    for (const artifact of [
      contents.server,
      contents.cli,
      contents.launcher,
      contents.desktop,
      contents.desktopUpdate.artifact,
    ]) {
      const name = nameSchema.parse(decodeURIComponent(basename(new URL(artifact.url).pathname)));
      const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${manifest.productVersion}/`;
      if (artifact.url !== `${base}${encodeURIComponent(name)}`)
        throw new Error("Product asset points outside the captured release");
      const actual = await fileIdentity(join(directory, name));
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
        throw new Error(`Manifest asset differs: ${name}`);
      expected.add(name);
    }
    const pin = NODE_PIN.targets[targetSchema.parse(target)];
    const node = {
      ...pin,
      url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-node-${NODE_PIN.version}/${basename(new URL(pin.url).pathname)}`,
    };
    if (
      contents.node.version !== NODE_PIN.version ||
      !isDeepStrictEqual(contents.node.artifact, node)
    )
      throw new Error("Manifest runtime differs from the committed pin");
    verifyArtifactSignature(
      await readFile(
        join(directory, basename(new URL(contents.desktopUpdate.artifact.url).pathname)),
      ),
      contents.desktopUpdate.signature,
    );
  }
  for (const name of expected) await fileIdentity(join(directory, name));
  const source = sourceSchema.parse(
    JSON.parse(await readFile(join(directory, "source.json"), "utf8")),
  );
  if (
    source.productVersion !== manifest.productVersion ||
    source.sourceCommit !== manifest.sourceCommit
  )
    throw new Error("Published source identity differs from the binaries");
  if (
    !isDeepStrictEqual(
      JSON.parse(await readFile(join(directory, "latest.json"), "utf8")),
      updaterMetadata(manifest),
    )
  )
    throw new Error("Tauri update metadata differs from the signed product");
  const sidecars = new Set([
    "release.json.sig",
    "release.json.minisig",
    "checksums.txt",
    "checksums.txt.sig",
  ]);
  if ((await assetNames(directory)).some((name) => !expected.has(name) && !sidecars.has(name)))
    throw new Error("Unexpected product publication asset");
  const runtime = join(directory, "runtime");
  const runtimeNames = new Set<string>();
  for (const pin of Object.values(NODE_PIN.targets)) {
    const name = basename(new URL(pin.url).pathname);
    runtimeNames.add(name);
    const actual = await fileIdentity(join(runtime, name));
    if (actual.size !== pin.size || actual.sha256 !== pin.sha256)
      throw new Error("Published runtime differs from the committed pin");
  }
  if (
    (await assetNames(runtime)).some(
      (name) => !runtimeNames.has(name) && !["checksums.txt", "checksums.txt.sig"].includes(name),
    )
  )
    throw new Error("Unexpected runtime publication asset");
}

export async function signPublication(directory: string): Promise<void> {
  const manifest = join(directory, "release.json");
  await verifyPublicationFiles(
    directory,
    releaseManifestSchema.parse(JSON.parse(await readFile(manifest, "utf8"))),
  );
  await signFile(manifest);
  const signature = await readFile(`${manifest}.sig`);
  const minisig = `${manifest}.minisig`;
  if ((await readdir(directory)).includes("release.json.minisig")) {
    if (!(await readFile(minisig)).equals(signature))
      throw new Error("Existing manifest signatures differ");
  } else await writeFile(minisig, signature, { flag: "wx" });
  verifyRelease(await readFile(manifest), signature.toString("utf8"));
  for (const group of [directory, join(directory, "runtime")]) {
    const path = join(group, "checksums.txt");
    const content = await checksums(group);
    if ((await readdir(group)).includes("checksums.txt")) {
      if ((await readFile(path, "utf8")) !== content)
        throw new Error("Prepared publication bytes changed");
    } else await writeFile(path, content, { flag: "wx" });
    await signFile(path);
  }
}

export async function publishPublication(directory: string, channel: string): Promise<void> {
  channelSchema.parse(channel);
  const manifest = releaseManifestSchema.parse(
    JSON.parse(
      verifyRelease(
        await readFile(join(directory, "release.json")),
        await readFile(join(directory, "release.json.minisig"), "utf8"),
      ),
    ),
  );
  if (
    manifest.productVersion !== PRODUCT_VERSION ||
    manifest.sourceCommit !== cleanSourceCommit(repositoryRoot)
  )
    throw new Error("Publication differs from the captured clean source");
  const targets = Object.keys(manifest.targets).sort();
  const expected = channel === "stable" ? Object.keys(NODE_PIN.targets).sort() : ["windows-x64"];
  if (JSON.stringify(targets) !== JSON.stringify(expected))
    throw new Error("Channel requires its complete declared target matrix");
  await verifyPublicationFiles(directory, manifest);
  // Verify the sealed complete sets, including source and notices, before any
  // GitHub mutation. Retrying a publisher cannot silently replace artifact bytes.
  for (const group of [directory, join(directory, "runtime")]) {
    const text = await readFile(join(group, "checksums.txt"), "utf8");
    verifyArtifactSignature(
      Buffer.from(text),
      (await readFile(join(group, "checksums.txt.sig"), "utf8")).trim(),
    );
    if (text !== (await checksums(group))) throw new Error("Signed publication bytes changed");
  }
  const source = sourceSchema.parse(
    JSON.parse(await readFile(join(directory, "source.json"), "utf8")),
  );
  if (
    source.productVersion !== manifest.productVersion ||
    source.sourceCommit !== manifest.sourceCommit
  )
    throw new Error("Published source identity differs from the binaries");
  if (source.missingNotices.length || !source.npmPreferredSourceComplete)
    throw new Error(
      "Corresponding source and dependency notices still require publication qualification",
    );
  const runtime = join(directory, "runtime");
  await publishDraft({
    repository: RELEASE_REPOSITORY,
    tag: `runtime-node-${NODE_PIN.version}`,
    title: `Node ${NODE_PIN.version} runtime`,
    notes:
      "Unmodified upstream Node distributions pinned by Harness. Licenses are included in each archive. This runtime release is retained for exact product references.",
    // Only the unchanged upstream archives belong to this immutable runtime
    // release. Per-product signature timestamps must not change its asset set.
    files: Object.values(NODE_PIN.targets).map((pin) =>
      join(runtime, basename(new URL(pin.url).pathname)),
    ),
    latest: false,
    prerelease: false,
  });
  const files = (await assetNames(directory)).map((name) => join(directory, name));
  await publishDraft({
    repository: RELEASE_REPOSITORY,
    tag: `v${PRODUCT_VERSION}`,
    title: `Harness ${PRODUCT_VERSION}`,
    notes: `Harness ${PRODUCT_VERSION}${channel === "windows-preview" ? " — Windows preview" : ""}\n\nSource: ${manifest.sourceCommit}\n\nOS publisher signing is not configured. Windows may show an unknown-publisher warning; macOS distribution requires the documented unsigned-app qualification. Project download and updater signatures are included. Corresponding source, build instructions and dependency notices accompany the binaries.`,
    files,
    latest: channel === "stable",
    prerelease: channel === "windows-preview",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare" && args.length === 4)
    await preparePublication(args[0]!, args[1]!, args[2]!.split(","), args[3]!);
  else if (command === "sign" && args.length === 1) await signPublication(args[0]!);
  else if (command === "publish" && args.length === 2) await publishPublication(args[0]!, args[1]!);
  else
    throw new Error(
      "Usage: finalize.ts prepare INPUT OUTPUT TARGETS SOURCE_DIR | sign OUTPUT | publish OUTPUT windows-preview|stable",
    );
}
