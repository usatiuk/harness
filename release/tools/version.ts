import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { versionSchema } from "@harness/release";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function cleanSourceCommit(root: string): string {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  if (git(["status", "--porcelain"])) throw new Error("Release commands require a clean checkout");
  return z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(git(["rev-parse", "HEAD"]));
}

export function nextVersion(current: string, bump: string): string {
  versionSchema.parse(current);
  if (current.includes("-")) throw new Error("Release bumps require a stable starting version");
  const parts = current.split(".").map(BigInt);
  const index = ["major", "minor", "patch"].indexOf(bump);
  if (index === -1) throw new Error("Expected patch, minor or major");
  parts[index] = parts[index]! + 1n;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0n;
  return versionSchema.parse(parts.join("."));
}

function replaceVersion(text: string, current: string, next: string, section: string): string {
  const header = `[${section}]`;
  const start = text.indexOf(header);
  if (start === -1) throw new Error(`Missing TOML section ${header}`);
  const end = text.indexOf("\n[", start + header.length);
  const tail = end === -1 ? text.length : end;
  const block = text.slice(start, tail);
  return text.slice(0, start) + replaceVersionLine(block, current, next, header) + text.slice(tail);
}

function replaceVersionLine(block: string, current: string, next: string, label: string): string {
  const versions = [...block.matchAll(/^version = "([^"]+)"$/gmu)];
  if (versions.length !== 1 || versions[0]![1] !== current)
    throw new Error(`Version mismatch in ${label}`);
  return block.replace(`version = "${current}"`, `version = "${next}"`);
}

function replaceLockVersions(text: string, names: string[], current: string, next: string): string {
  const found = new Set<string>();
  const result = text.replace(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/gu, (block) => {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    if (!name || !names.includes(name)) return block;
    if (found.has(name)) throw new Error(`Duplicate local Cargo package ${name}`);
    found.add(name);
    return replaceVersionLine(block, current, next, `Cargo package ${name}`);
  });
  if (found.size !== names.length) throw new Error("Cargo lockfile is missing a local package");
  return result;
}

/** Validate every input before changing any file. An interrupted write leaves a dirty,
 * non-releasable checkout; the workflow never builds a partially bumped identity. */
export async function bumpVersion(root: string, bump: string): Promise<string> {
  cleanSourceCommit(root);
  const paths = [
    "release/product.json",
    "package.json",
    "package-lock.json",
    "packages/desktop/src-tauri/tauri.conf.json",
    "native/Cargo.toml",
    "packages/desktop/src-tauri/Cargo.toml",
    "native/Cargo.lock",
    "packages/desktop/src-tauri/Cargo.lock",
  ];
  const texts = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  const documents = texts
    .slice(0, 4)
    .map((text) => z.looseObject({ version: versionSchema }).parse(JSON.parse(text)));
  const current = documents[0]!.version;
  const next = nextVersion(current, bump);
  for (const document of documents) {
    if (document.version !== current) throw new Error("Product/npm/Tauri versions differ");
    document.version = next;
  }
  const lock = documents[2]!;
  const packages = z.record(z.string(), z.unknown()).parse(lock.packages);
  const lockRoot = z.looseObject({ version: versionSchema }).parse(packages[""]);
  if (lockRoot.version !== current) throw new Error("npm root lockfile version differs");
  lockRoot.version = next;
  packages[""] = lockRoot;
  lock.packages = packages;
  const contents = [
    ...documents.map((document) => `${JSON.stringify(document, null, 2)}\n`),
    replaceVersion(texts[4]!, current, next, "workspace.package"),
    replaceVersion(texts[5]!, current, next, "package"),
    replaceLockVersions(
      texts[6]!,
      ["harness-bootstrap", "harness-launcher", "harness-native"],
      current,
      next,
    ),
    replaceLockVersions(texts[7]!, ["harness-bootstrap", "harness-desktop"], current, next),
  ];
  for (let i = 0; i < paths.length; i++) {
    const path = join(root, paths[i]!);
    const temporary = `${path}.release-version`;
    await writeFile(temporary, contents[i]!, { flag: "wx" });
    await rename(temporary, path);
  }
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: release:version patch|minor|major");
  process.stdout.write(`${await bumpVersion(repositoryRoot, process.argv[2]!)}\n`);
}
