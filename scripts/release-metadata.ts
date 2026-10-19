import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactSchema,
  NODE_PIN,
  PRODUCT_VERSION,
  RELEASE_REPOSITORY,
  releaseManifestSchema,
  type ReleaseArtifact,
} from "@harness/release";

const directory = process.argv[2];
if (!directory) throw new Error("Expected an artifact directory");
if (process.argv[3] === "--verify") {
  const { verifyRelease, verifyArtifactSignature } = await import("@harness/native");
  verifyRelease(
    await readFile(join(directory, "release.json")),
    await readFile(join(directory, "release.json.minisig"), "utf8"),
  );
  for (const name of await readdir(directory)) {
    if (name.endsWith(".sig"))
      verifyArtifactSignature(
        await readFile(join(directory, name.slice(0, -4))),
        await readFile(join(directory, name), "utf8"),
      );
  }
  process.exit(0);
}
const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${PRODUCT_VERSION}/`;
async function artifact(
  name: string,
  format: ReleaseArtifact["format"],
  root: string,
  entry: string,
) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(join(directory!, name))) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return artifactSchema.parse({
    url: base + name,
    size,
    sha256: hash.digest("hex"),
    format,
    root,
    entry,
  });
}
const platforms = [
  ["windows-x64", ".exe", "windows-x86_64"],
  ["linux-x64-glibc", ".AppImage", "linux-x86_64"],
  ["linux-arm64-glibc", ".AppImage", "linux-aarch64"],
  ["macos-arm64", ".dmg", "darwin-aarch64"],
] as const;
const targets: Record<string, unknown> = {};
const updates: Record<string, { url: string; signature: string }> = {};
for (const [target, extension, updater] of platforms) {
  const prefix = `harness-v${PRODUCT_VERSION}-${target}`;
  const update = `${prefix}-desktop${extension === ".dmg" ? ".app.tar.gz" : extension}`;
  const launcher = `harness-${target.replace("-glibc", "")}${target === "windows-x64" ? ".exe" : ""}`;
  targets[target] = {
    node: { version: NODE_PIN.version, artifact: NODE_PIN.targets[target] },
    server: await artifact(`${prefix}-server.tar.gz`, "tarGz", "server", "server.mjs"),
    cli: await artifact(`${prefix}-cli.tar.gz`, "tarGz", "cli", "cli.mjs"),
    launcher: await artifact(launcher, "file", launcher, launcher),
  };
  updates[updater] = {
    url: base + update,
    signature: (await readFile(join(directory, `${update}.sig`), "utf8")).trim(),
  };
}
const manifest = releaseManifestSchema.parse({
  formatVersion: 1,
  productVersion: PRODUCT_VERSION,
  targets,
});
await writeFile(join(directory, "release.json"), JSON.stringify(manifest, null, 2));
await writeFile(
  join(directory, "latest.json"),
  JSON.stringify({ version: PRODUCT_VERSION, platforms: updates }, null, 2),
);
