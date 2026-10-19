import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  artifactSchema,
  developmentRemoteSchema,
  linuxTargetSchema,
  NODE_PIN,
  PRODUCT_VERSION,
  releaseManifestSchema,
  targetSchema,
  versionSchema,
} from "./index.ts";
import cases from "../../../release/fixtures/validation.json" with { type: "json" };

const artifact = {
  url: "https://example.invalid/server.tar.gz",
  size: 123,
  sha256: "a".repeat(64),
  format: "tarGz",
  root: "server",
  entry: "server.mjs",
};

it("agrees with the native bootstrap on executable metadata boundaries", () => {
  for (const value of cases.validVersions)
    expect(versionSchema.safeParse(value).success).toBe(true);
  for (const value of cases.invalidVersions)
    expect(versionSchema.safeParse(value).success).toBe(false);
  for (const entry of cases.validPaths)
    expect(artifactSchema.safeParse({ ...artifact, entry }).success).toBe(true);
  for (const entry of cases.invalidPaths)
    expect(artifactSchema.safeParse({ ...artifact, entry }).success).toBe(false);
  for (const url of cases.validUrls)
    expect(artifactSchema.safeParse({ ...artifact, url }).success).toBe(true);
  for (const url of cases.invalidUrls)
    expect(artifactSchema.safeParse({ ...artifact, url }).success).toBe(false);
});

it("assembles download metadata and Tauri updates from the shipped native artifact sets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-metadata-"));
  const targets = [
    ["windows-x64", ".exe", "windows-x86_64"],
    ["linux-x64-glibc", ".AppImage", "linux-x86_64"],
    ["linux-arm64-glibc", ".AppImage", "linux-aarch64"],
    ["macos-arm64", ".app.tar.gz", "darwin-aarch64"],
  ] as const;
  try {
    for (const [target, update] of targets) {
      const prefix = `harness-v${PRODUCT_VERSION}-${target}`;
      for (const file of ["server.tar.gz", "cli.tar.gz"])
        await writeFile(join(directory, `${prefix}-${file}`), `${target}/${file}`);
      const launcher = `harness-${target.replace("-glibc", "")}${target === "windows-x64" ? ".exe" : ""}`;
      await writeFile(join(directory, launcher), `${target}/launcher`);
      await writeFile(join(directory, `${prefix}-desktop${update}.sig`), `signature-${target}`);
    }
    await promisify(execFile)(
      process.execPath,
      ["--conditions=development", "--import=tsx", "scripts/release-metadata.ts", directory],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        windowsHide: true,
        timeout: 30_000,
      },
    );
    const raw: unknown = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
    const release = releaseManifestSchema.parse(raw);
    expect(raw).toEqual(release);
    expect(Object.keys(release.targets).sort()).toEqual(targets.map(([target]) => target).sort());
    const updates: unknown = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
    const platforms: Record<string, { url: string; signature: string }> = {};
    for (const [target, update, updater] of targets) {
      const prefix = `harness-v${PRODUCT_VERSION}-${target}`;
      const bytes = `${target}/server.tar.gz`;
      expect(release.targets[target]?.server).toMatchObject({
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        root: "server",
        entry: "server.mjs",
      });
      const launcher = `harness-${target.replace("-glibc", "")}${target === "windows-x64" ? ".exe" : ""}`;
      expect(release.targets[target]?.launcher).toMatchObject({
        url: `https://github.com/usatiuk/harness/releases/download/v${PRODUCT_VERSION}/${launcher}`,
        entry: launcher,
      });
      platforms[updater] = {
        url: `https://github.com/usatiuk/harness/releases/download/v${PRODUCT_VERSION}/${prefix}-desktop${update}`,
        signature: `signature-${target}`,
      };
    }
    expect(updates).toEqual({ version: PRODUCT_VERSION, platforms });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("accepts exactly the two Linux glibc remote targets with pinned runtime descriptors", () => {
  const metadata = {
    formatVersion: 1,
    productVersion: PRODUCT_VERSION,
    nodeVersion: NODE_PIN.version,
    server: { size: 1, sha256: "a".repeat(64) },
    bootstrap: { size: 1, sha256: "b".repeat(64) },
  };
  for (const target of ["linux-x64-glibc", "linux-arm64-glibc"] as const) {
    expect(linuxTargetSchema.parse(target)).toBe(target);
    expect(targetSchema.parse(target)).toBe(target);
    expect(developmentRemoteSchema.parse({ ...metadata, target }).target).toBe(target);
    expect(artifactSchema.safeParse(NODE_PIN.targets[target]).success).toBe(true);
  }
  for (const target of [
    "linux-arm64-musl",
    "linux-x64-musl",
    "linux-arm",
    "windows-x64",
    "macos-arm64",
  ]) {
    expect(linuxTargetSchema.safeParse(target).success).toBe(false);
    expect(developmentRemoteSchema.safeParse({ ...metadata, target }).success).toBe(false);
  }
});

it("maps native Linux hosts to their own Rust and release artifacts", async () => {
  for (const [arch, release, rust] of [
    ["x64", "linux-x64-glibc", "x86_64-unknown-linux-gnu"],
    ["arm64", "linux-arm64-glibc", "aarch64-unknown-linux-gnu"],
  ]) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });
      const { nativeTarget } = await import("./scripts/native-target.mjs");
      console.log(JSON.stringify(nativeTarget()));
    `,
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)) },
    );
    expect(JSON.parse(stdout)).toEqual({ release, rust, library: "libharness_native.so" });
  }
});

it("reads the normal ARM64 target map without a special wire format", async () => {
  const wire: unknown = JSON.parse(
    await readFile(
      new URL("../../../native/bootstrap/tests/fixtures/arm64-release.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = releaseManifestSchema.parse(wire);
  expect(manifest).toEqual(wire);
  expect(manifest.targets["linux-arm64-glibc"]?.node).toEqual({
    version: NODE_PIN.version,
    artifact: NODE_PIN.targets["linux-arm64-glibc"],
  });
});

it("accepts foreign platform names without widening supported runtime targets", () => {
  const entry = {
    node: { version: NODE_PIN.version, artifact },
    server: artifact,
    cli: artifact,
    launcher: artifact,
  };
  const manifest = {
    formatVersion: 1,
    productVersion: PRODUCT_VERSION,
    targets: { "linux-x64-glibc": entry, "futureos-riscv128": entry },
  };
  expect(releaseManifestSchema.parse(manifest)).toEqual(manifest);
  expect(releaseManifestSchema.safeParse({ ...manifest, targets: {} }).success).toBe(false);
  expect(targetSchema.safeParse("futureos-riscv128").success).toBe(false);
  expect(linuxTargetSchema.safeParse("futureos-riscv128").success).toBe(false);
  expect(
    developmentRemoteSchema.safeParse({
      formatVersion: 1,
      target: "futureos-riscv128",
      productVersion: PRODUCT_VERSION,
      nodeVersion: NODE_PIN.version,
      server: { size: 1, sha256: "a".repeat(64) },
      bootstrap: { size: 1, sha256: "b".repeat(64) },
    }).success,
  ).toBe(false);
  for (const bad of [
    null,
    {},
    { ...entry, node: { ...entry.node, version: "bad" } },
    { ...entry, server: { ...artifact, sha256: "invalid" } },
    { ...entry, cli: { ...artifact, url: "http://example.invalid/cli" } },
    { ...entry, launcher: { ...artifact, entry: "../escape" } },
    { ...entry, server: { ...artifact, format: "futureArchive" } },
  ]) {
    expect(
      releaseManifestSchema.safeParse({
        ...manifest,
        targets: { ...manifest.targets, "futureos-riscv128": bad },
      }).success,
    ).toBe(false);
  }
});
