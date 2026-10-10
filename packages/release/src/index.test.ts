import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { artifactSchema, PRODUCT_VERSION, releaseManifestSchema, versionSchema } from "./index.ts";
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

it("assembles download metadata and Tauri updates from four native artifact sets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-metadata-"));
  const targets = [
    ["windows-x64", ".exe", "windows-x86_64"],
    ["linux-x64-glibc", ".AppImage", "linux-x86_64"],
    ["macos-arm64", ".app.tar.gz", "darwin-aarch64"],
    ["macos-x64", ".app.tar.gz", "darwin-x86_64"],
  ] as const;
  try {
    for (const [target, update] of targets) {
      const prefix = `harness-v${PRODUCT_VERSION}-${target}`;
      for (const file of [
        "server.tar.gz",
        "cli.tar.gz",
        `bootstrap${target === "windows-x64" ? ".exe" : ""}`,
      ])
        await writeFile(join(directory, `${prefix}-${file}`), `${target}/${file}`);
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
      platforms[updater] = {
        url: `https://github.com/usatiuk/harness-releases/releases/download/v${PRODUCT_VERSION}/${prefix}-desktop${update}`,
        signature: `signature-${target}`,
      };
    }
    expect(updates).toEqual({ version: PRODUCT_VERSION, platforms });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
