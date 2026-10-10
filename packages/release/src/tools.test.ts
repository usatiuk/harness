import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpVersion, nextVersion } from "../../../release/tools/version.ts";
import {
  assembleRelease,
  fileIdentity,
  packageTarget,
  recordDesktopBuild,
} from "../../../release/tools/artifacts.ts";
import {
  NODE_PIN,
  PRODUCT_VERSION,
  RELEASE_REPOSITORY,
  type ReleaseArtifact,
  type ReleaseTarget,
} from "./index.ts";

// Control the upstream runtime pin and cryptographic/native process edges. Real
// files, hashes, git and tar exercise the packaging boundary. These tiny payloads
// do not establish target ABI, installed runtime or native signature qualification.
vi.mock("@harness/release", async (original) => {
  const actual = await original<typeof import("./index.ts")>();
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("controlled upstream Node archive");
  const targets = Object.fromEntries(
    Object.entries(actual.NODE_PIN.targets).map(([target, artifact]) => [
      target,
      { ...artifact, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ]),
  );
  return { ...actual, NODE_PIN: { ...actual.NODE_PIN, targets } };
});
vi.mock("@harness/native", () => ({
  verifyArtifactSignature: (bytes: Buffer, signature: string) => {
    if (signature !== bytes.toString("base64")) throw new Error("Invalid controlled signature");
  },
}));
const nativeIdentity = vi.hoisted(() => ({ value: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[1]?.[0] === "--build-info") return nativeIdentity.value;
      return actual.execFileSync(...args);
    },
  };
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-tool-"));
  temporary.push(directory);
  return directory;
}
async function put(root: string, path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}
async function versionCheckout(): Promise<string> {
  const root = await workspace();
  const version = "0.1.0";
  for (const path of [
    "release/product.json",
    "package.json",
    "packages/desktop/src-tauri/tauri.conf.json",
  ])
    await put(root, path, JSON.stringify({ version, preserved: "value" }));
  await put(
    root,
    "package-lock.json",
    JSON.stringify({
      version,
      packages: { "": { version }, "node_modules/fixture": { version: "7.8.9" } },
    }),
  );
  await put(
    root,
    "native/Cargo.toml",
    `[workspace.package]\nversion = "${version}"\nedition = "2024"\n`,
  );
  await put(
    root,
    "packages/desktop/src-tauri/Cargo.toml",
    `[package]\nname = "harness-desktop"\nversion = "${version}"\n\n[dependencies]\nexample = "${version}"\n`,
  );
  for (const [path, names] of [
    ["native/Cargo.lock", ["harness-bootstrap", "harness-launcher", "harness-native"]],
    ["packages/desktop/src-tauri/Cargo.lock", ["harness-bootstrap", "harness-desktop"]],
  ] as const)
    await put(
      root,
      path,
      [...names, "dependency"]
        .map((name) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)
        .join("\n"),
    );
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=release@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Create fixture",
  ]);
  return root;
}

describe("release version cut", () => {
  it("increments stable SemVer without changing unrelated versions", async () => {
    expect(nextVersion("3.4.5", "patch")).toBe("3.4.6");
    expect(nextVersion("3.4.5", "minor")).toBe("3.5.0");
    expect(nextVersion("3.4.5", "major")).toBe("4.0.0");
    expect(() => nextVersion("3.4.5-preview", "patch")).toThrow("stable");
    expect(() => nextVersion("3.4.5", "typo")).toThrow("patch, minor or major");
    const root = await versionCheckout();
    expect(await bumpVersion(root, "minor")).toBe("0.2.0");
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""]!.version).toBe("0.2.0");
    expect(lock.packages["node_modules/fixture"]!.version).toBe("7.8.9");
    const cargo = await readFile(join(root, "native/Cargo.lock"), "utf8");
    expect(cargo.match(/version = "0.2.0"/gu)).toHaveLength(3);
    expect(cargo).toContain('name = "dependency"\nversion = "0.1.0"');
    expect(await readFile(join(root, "packages/desktop/src-tauri/Cargo.toml"), "utf8")).toContain(
      'example = "0.1.0"',
    );
    for (const path of [
      "release/product.json",
      "package.json",
      "packages/desktop/src-tauri/tauri.conf.json",
    ])
      expect(JSON.parse(await readFile(join(root, path), "utf8"))).toMatchObject({
        version: "0.2.0",
        preserved: "value",
      });
  });

  it("rejects dirty or mismatched source before changing any product identity", async () => {
    const root = await versionCheckout();
    await put(root, "extra.txt", "dirty");
    await expect(bumpVersion(root, "patch")).rejects.toThrow("clean checkout");
    await rm(join(root, "extra.txt"));
    await put(root, "native/Cargo.toml", '[workspace.package]\nversion = "9.9.9"\n');
    execFileSync("git", ["add", "."], { cwd: root, windowsHide: true });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Fixture",
        "-c",
        "user.email=release@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Mismatch",
      ],
      { cwd: root, windowsHide: true },
    );
    await expect(bumpVersion(root, "patch")).rejects.toThrow("Version mismatch");
    expect(JSON.parse(await readFile(join(root, "release/product.json"), "utf8"))).toMatchObject({
      version: "0.1.0",
    });
  });
});

const sourceCommit = "a".repeat(40);
const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${PRODUCT_VERSION}/`;
async function identity(target: ReleaseTarget) {
  return {
    mode: "release",
    productVersion: PRODUCT_VERSION,
    sourceCommit,
    target,
    nodeVersion: NODE_PIN.version,
    releaseManifestUrl: `${base}release.json`,
    releaseVerificationPublicKey: (
      await readFile(new URL("../../../release/verification-key.pub", import.meta.url), "utf8")
    ).trim(),
  };
}
async function fixtureBundle(root: string, target: ReleaseTarget): Promise<string> {
  const directory = join(root, target);
  await mkdir(directory, { recursive: true });
  const artifact = async (name: string, bytes = name): Promise<ReleaseArtifact> => {
    const path = join(directory, name);
    await writeFile(path, bytes);
    return {
      url: `${base}${name}`,
      ...(await fileIdentity(path)),
      format: "file",
      root: "payload",
      entry: name,
    };
  };
  const pin = NODE_PIN.targets[target];
  const nodeName = basename(new URL(pin.url).pathname);
  await put(directory, nodeName, "controlled upstream Node archive");
  const update = await artifact(`${target}-desktop.exe`);
  const contents = {
    minimumPlatform: "controlled platform",
    node: {
      version: NODE_PIN.version,
      artifact: {
        ...pin,
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-node-${NODE_PIN.version}/${nodeName}`,
      },
    },
    server: await artifact(`${target}-server.tar.gz`),
    cli: await artifact(`${target}-cli.tar.gz`),
    launcher: await artifact(`${target}-launcher`),
    desktop: update,
    desktopUpdate: {
      artifact: update,
      signature: Buffer.from(`${target}-desktop.exe`).toString("base64"),
    },
  };
  await put(
    directory,
    "target.json",
    JSON.stringify({
      identity: await identity(target),
      contents,
      desktopBuild: {
        identity: await identity(target),
        executable: { name: "harness-desktop", size: 1, sha256: "a".repeat(64) },
        installer: { name: `${target}-desktop.exe`, size: update.size, sha256: update.sha256 },
        update: {
          name: `${target}-desktop.exe`,
          size: update.size,
          sha256: update.sha256,
          signature: contents.desktopUpdate.signature,
        },
      },
    }),
  );
  return directory;
}

async function packageFixture() {
  const root = await workspace();
  const payloads = join(root, "payloads");
  const build = await identity("macos-arm64");
  nativeIdentity.value = JSON.stringify(build);
  for (const component of ["cli", "server"]) {
    await put(payloads, `${component}/build.json`, JSON.stringify(build));
    await put(
      payloads,
      `${component}/${component}.mjs`,
      `export const component = "${component}";`,
    );
  }
  await put(root, "launcher", "controlled native executable");
  await put(root, "node.tar.gz", "controlled upstream Node archive");
  await put(root, "Harness.dmg", "controlled installer");
  await put(root, "Harness.app.tar.gz", "controlled updater");
  await put(root, "Harness.app.tar.gz.sig", Buffer.from("controlled updater").toString("base64"));
  await recordDesktopBuild({
    executable: join(root, "launcher"),
    installer: join(root, "Harness.dmg"),
    update: join(root, "Harness.app.tar.gz"),
    sourceCommit,
    output: join(root, "desktop-build"),
  });
  return {
    root,
    build,
    options: {
      payloads,
      output: join(root, "packaged"),
      sourceCommit,
      launcher: join(root, "launcher"),
      nodeArchive: join(root, "node.tar.gz"),
      minimumPlatform: "controlled platform",
      desktopBuild: join(root, "desktop-build/desktop-build.json"),
    },
  };
}

describe("exact release artifact assembly", () => {
  it("assembles a declared matrix and matching Tauri metadata from exact bytes", async () => {
    const root = await workspace();
    const input = join(root, "inputs");
    await fixtureBundle(input, "windows-x64");
    await fixtureBundle(input, "linux-x64-glibc");
    const output = join(root, "assembled");
    const manifest = await assembleRelease(
      input,
      output,
      ["windows-x64", "linux-x64-glibc"],
      sourceCommit,
    );
    expect(Object.keys(manifest.targets)).toEqual(["windows-x64", "linux-x64-glibc"]);
    expect(manifest.pluginContracts).toMatchObject({ mcp: "1" });
    const latest = JSON.parse(await readFile(join(output, "latest.json"), "utf8")) as {
      version: string;
      platforms: Record<string, { url: string }>;
    };
    expect(latest.version).toBe(manifest.productVersion);
    expect(latest.platforms["windows-x86_64"]!.url).toBe(
      manifest.targets["windows-x64"]!.desktopUpdate!.artifact.url,
    );
    for (const target of Object.values(manifest.targets)) {
      const path = join(output, basename(new URL(target.launcher.url).pathname));
      expect(await fileIdentity(path)).toMatchObject({
        size: target.launcher.size,
        sha256: target.launcher.sha256,
      });
    }
    await expect(
      assembleRelease(input, output, ["windows-x64", "linux-x64-glibc"], sourceCommit),
    ).rejects.toThrow();
  });

  it("rejects altered bytes and signatures before publishing an output directory", async () => {
    const root = await workspace();
    const directory = await fixtureBundle(join(root, "inputs"), "windows-x64");
    await put(directory, "windows-x64-launcher", "tampered");
    await expect(
      assembleRelease(join(root, "inputs"), join(root, "output"), ["windows-x64"], sourceCommit),
    ).rejects.toThrow("changed");
    const descriptor = JSON.parse(await readFile(join(directory, "target.json"), "utf8")) as {
      contents: { launcher: ReleaseArtifact; desktopUpdate: { signature: string } };
    };
    descriptor.contents.launcher = {
      ...descriptor.contents.launcher,
      ...(await fileIdentity(join(directory, "windows-x64-launcher"))),
    };
    descriptor.contents.desktopUpdate.signature = "wrong key/signature";
    await put(directory, "target.json", JSON.stringify(descriptor));
    await expect(
      assembleRelease(join(root, "inputs"), join(root, "output"), ["windows-x64"], sourceCommit),
    ).rejects.toThrow("signature");
    expect(await readdir(root)).toEqual(["inputs"]);
  });

  it("rejects a mixed source commit, missing target and undeclared matrix", async () => {
    const root = await workspace();
    const input = join(root, "inputs");
    await fixtureBundle(input, "windows-x64");
    await expect(
      assembleRelease(input, join(root, "output"), ["windows-x64"], "b".repeat(40)),
    ).rejects.toThrow("sourceCommit");
    await expect(
      assembleRelease(input, join(root, "output"), ["windows-x64", "macos-arm64"], sourceCommit),
    ).rejects.toThrow("ENOENT");
    await fixtureBundle(input, "linux-x64-glibc");
    await expect(
      assembleRelease(input, join(root, "output"), ["windows-x64"], sourceCommit),
    ).rejects.toThrow("undeclared");
    await expect(
      assembleRelease(input, join(root, "output"), ["windows-x64", "windows-x64"], sourceCommit),
    ).rejects.toThrow("once");
  });

  it("packages actual tar files and gives same-named macOS updates unique URLs", async () => {
    const { root, options } = await packageFixture();
    const output = options.output;
    await packageTarget(options);
    const descriptor = JSON.parse(await readFile(join(output, "target.json"), "utf8")) as {
      contents: { server: ReleaseArtifact; desktopUpdate: { artifact: ReleaseArtifact } };
    };
    expect(descriptor.contents.desktopUpdate.artifact.url).toContain(
      "macos-arm64-desktop-update.tar.gz",
    );
    const archive = join(output, basename(new URL(descriptor.contents.server.url).pathname));
    const unpacked = join(root, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar", ["-xzf", archive, "-C", unpacked], { windowsHide: true });
    expect(await readFile(join(unpacked, "server/server.mjs"), "utf8")).toBe(
      'export const component = "server";',
    );
    expect(await fileIdentity(archive)).toMatchObject({
      size: descriptor.contents.server.size,
      sha256: descriptor.contents.server.sha256,
    });
  });

  it("rejects changed Node archive layout even when the original hash still matches", async () => {
    const root = await workspace();
    const input = join(root, "inputs");
    const directory = await fixtureBundle(input, "windows-x64");
    const descriptor = JSON.parse(await readFile(join(directory, "target.json"), "utf8")) as {
      contents: { node: { artifact: ReleaseArtifact } };
    };
    const pin = { ...descriptor.contents.node.artifact };
    for (const mutation of [
      { entry: "wrong.exe" },
      { root: "wrong-root" },
      { format: "file" as const },
    ]) {
      descriptor.contents.node.artifact = { ...pin, ...mutation };
      await put(directory, "target.json", JSON.stringify(descriptor));
      await expect(
        assembleRelease(input, join(root, "output"), ["windows-x64"], sourceCommit),
      ).rejects.toThrow("Runtime layout");
    }
  });

  it("rejects stale native and signed desktop identities, and changed installer bytes", async () => {
    const { root, build, options } = await packageFixture();
    nativeIdentity.value = JSON.stringify({ ...build, sourceCommit: "b".repeat(40) });
    await expect(packageTarget(options)).rejects.toThrow("sourceCommit");
    nativeIdentity.value = JSON.stringify(build);
    const original = await readFile(options.desktopBuild, "utf8");
    const record = JSON.parse(original) as { identity: { productVersion: string } };
    record.identity.productVersion = "0.0.9";
    await writeFile(options.desktopBuild, JSON.stringify(record));
    // The controlled update signature remains valid; its build identity is stale.
    await expect(packageTarget(options)).rejects.toThrow("productVersion");
    await writeFile(options.desktopBuild, original);
    await put(root, "desktop-build/Harness.dmg", "another build's installer");
    await expect(packageTarget(options)).rejects.toThrow("Desktop build output changed");
    expect(await readdir(root)).not.toContain("packaged");
  });

  it("cleans a failed new package and never deletes an existing output", async () => {
    const { options } = await packageFixture();
    const original = await readFile(options.desktopBuild, "utf8");
    const record = JSON.parse(original) as { update: { signature: string } };
    record.update.signature = "invalid";
    await writeFile(options.desktopBuild, JSON.stringify(record));
    await expect(packageTarget(options)).rejects.toThrow("signature");
    await expect(readdir(options.output)).rejects.toThrow("ENOENT");
    await writeFile(options.desktopBuild, original);
    await mkdir(options.output);
    await put(options.output, "sentinel", "preserve previous output");
    await expect(packageTarget(options)).rejects.toThrow("EEXIST");
    expect(await readFile(join(options.output, "sentinel"), "utf8")).toBe(
      "preserve previous output",
    );
  });
});
