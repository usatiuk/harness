import { z } from "zod";
import { valid } from "semver";
export { compare as compareVersions } from "semver";
import product from "../../../package.json" with { type: "json" };
import nodePin from "../../../release/node.json" with { type: "json" };

export const PRODUCT_VERSION = product.version;
export const RELEASE_REPOSITORY = "usatiuk/harness";
export const NODE_PIN = nodePin;
export const linuxTargetSchema = z.enum(["linux-x64-glibc", "linux-arm64-glibc"]);
export type LinuxTarget = z.infer<typeof linuxTargetSchema>;
export const targetSchema = z.enum([
  "windows-x64",
  ...linuxTargetSchema.options,
  "macos-arm64",
  "macos-x64",
]);
export type ReleaseTarget = z.infer<typeof targetSchema>;
export const versionSchema = z
  .string()
  .refine(
    (value) => valid(value) === value && !value.includes("+"),
    "Expected SemVer without build metadata",
  );
const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":")),
    "Expected a relative payload path",
  );
export const artifactSchema = z.strictObject({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, "HTTPS without credentials or fragments required"),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  format: z.enum(["tarGz", "zip", "file"]),
  root: pathSchema,
  entry: pathSchema,
});
export type ReleaseArtifact = z.infer<typeof artifactSchema>;
const releaseTargetSchema = z.object({
  node: z.strictObject({ version: versionSchema, artifact: artifactSchema }),
  server: artifactSchema,
  cli: artifactSchema,
  launcher: artifactSchema,
});
export const releaseManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    productVersion: versionSchema,
    targets: z.partialRecord(targetSchema, releaseTargetSchema),
    // Older verifiers reject unknown target keys but ignore unknown root fields.
    // Keep the signed wire extension separate; consumers use one canonical map.
    linuxArm64Glibc: releaseTargetSchema.optional(),
  })
  .refine(
    (value) => !(value.linuxArm64Glibc && value.targets["linux-arm64-glibc"]),
    "Duplicate Linux ARM64 release target",
  )
  .transform(({ linuxArm64Glibc, ...manifest }) => ({
    ...manifest,
    targets: linuxArm64Glibc
      ? { ...manifest.targets, "linux-arm64-glibc": linuxArm64Glibc }
      : manifest.targets,
  }))
  .refine((value) => Object.keys(value.targets).length > 0, "At least one release target required");
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
const transferredFileSchema = z.strictObject({
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** Explicit source artifact made on the remote platform, never a host Node choice. */
export const developmentRemoteSchema = z.strictObject({
  formatVersion: z.literal(1),
  target: linuxTargetSchema,
  productVersion: versionSchema,
  nodeVersion: versionSchema,
  server: transferredFileSchema,
  bootstrap: transferredFileSchema,
});
export interface BuildIdentity {
  mode: "development" | "release";
  productVersion: string;
  target: ReleaseTarget | "development";
  nodeVersion: string;
}
declare const __HARNESS_BUILD__: BuildIdentity | undefined;
/** Bundlers replace this with captured release inputs; source runs retain an explicit identity. */
export const BUILD_IDENTITY: BuildIdentity =
  typeof __HARNESS_BUILD__ === "undefined"
    ? {
        mode: "development",
        productVersion: PRODUCT_VERSION,
        target: "development",
        nodeVersion: nodePin.version,
      }
    : __HARNESS_BUILD__;

export const PRODUCT_USER_AGENT = `Harness/${BUILD_IDENTITY.productVersion}`;
