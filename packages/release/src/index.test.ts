import { describe, expect, it } from "vitest";
import { artifactSchema, releaseManifestSchema, versionSchema, PRODUCT_VERSION } from "./index.ts";
import cases from "../../../release/fixtures/validation.json" with { type: "json" };

const artifact = {
  url: "https://example.invalid/server.tar.gz",
  size: 123,
  sha256: "a".repeat(64),
  format: "tarGz",
  root: "server",
  entry: "server.mjs",
};

describe("release descriptors", () => {
  it("uses the same executable metadata contract as the native bootstrap", () => {
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
  it("rejects unsafe executable paths and unauthenticated origins", () => {
    for (const entry of ["../outside", "/absolute", "C:/outside", "a\\b", "a/./b", "a//b"])
      expect(artifactSchema.safeParse({ ...artifact, entry }).success).toBe(false);
    expect(
      artifactSchema.safeParse({ ...artifact, url: "http://example.invalid/server" }).success,
    ).toBe(false);
  });
  it("requires a complete versioned target without inferring omitted components", () => {
    const manifest = {
      formatVersion: 1,
      productVersion: PRODUCT_VERSION,
      sourceCommit: "a".repeat(40),
      managementVersion: 1,
      protocolVersion: 4,
      storeSchemaVersion: 4,
      pluginContracts: {},
      targets: {
        "windows-x64": {
          minimumPlatform: "Windows 10",
          node: { version: "22.23.3", artifact },
          server: artifact,
          cli: artifact,
          launcher: { ...artifact, format: "file" },
        },
      },
    };
    expect(releaseManifestSchema.parse(manifest).productVersion).toBe(PRODUCT_VERSION);
    expect(releaseManifestSchema.safeParse({ ...manifest, formatVersion: 2 }).success).toBe(false);
    expect(releaseManifestSchema.safeParse({ ...manifest, targets: {} }).success).toBe(false);
    expect(
      releaseManifestSchema.safeParse({
        ...manifest,
        targets: { ...manifest.targets, "linux-musl": {} },
      }).success,
    ).toBe(false);
  });
});
