import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadRuntime,
  preparePublication,
  publishPublication,
  signPublication,
} from "../../../release/tools/finalize.ts";
import { fileIdentity, updaterMetadata } from "../../../release/tools/artifacts.ts";
import type { DraftOptions } from "../../../release/tools/publish.ts";
import {
  NODE_PIN,
  PRODUCT_VERSION,
  RELEASE_REPOSITORY,
  artifactSchema,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseTarget,
} from "./index.ts";

const edges = vi.hoisted(() => ({
  sourceCommit: "a".repeat(40),
  signed: [] as string[],
  publications: [] as { options: DraftOptions; hashes: Record<string, string> }[],
}));

// Real files and streaming hashes exercise finalization. Controlled crypto and
// GitHub edges keep these tests away from project keys and external publication;
// the tiny payloads do not qualify platform packages or corresponding source.
vi.mock("@harness/release", async (original) => {
  const actual = await original<typeof import("./index.ts")>();
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    NODE_PIN: {
      ...actual.NODE_PIN,
      targets: Object.fromEntries(
        Object.entries(actual.NODE_PIN.targets).map(([target, pin]) => {
          const bytes = Buffer.from(`controlled upstream archive ${target}`);
          return [
            target,
            {
              ...pin,
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ];
        }),
      ),
    },
  };
});
vi.mock("@harness/native", async () => {
  const { createHash } = await import("node:crypto");
  const verify = (bytes: Buffer, signature: string) => {
    const expected = `controlled:${createHash("sha256").update(bytes).digest("hex")}`;
    if (signature.trim() !== expected) throw new Error("Controlled signature verification failed");
  };
  return {
    verifyArtifactSignature: verify,
    verifyRelease: (bytes: Buffer, signature: string) => {
      verify(bytes, signature);
      return bytes.toString("utf8");
    },
  };
});
vi.mock("../../../release/tools/version.ts", async (original) => ({
  ...(await original<typeof import("../../../release/tools/version.ts")>()),
  cleanSourceCommit: () => edges.sourceCommit,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    execFileSync: (program: string, args: string[]) => {
      if (!args.includes("signer") || !args.includes("sign"))
        throw new Error(`Unexpected process edge: ${program}`);
      const path = args.at(-1)!;
      const signature = `controlled:${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`;
      writeFileSync(`${path}.sig`, signature, { flag: "wx" });
      edges.signed.push(path);
      return Buffer.alloc(0);
    },
  };
});
vi.mock("../../../release/tools/publish.ts", async () => {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const { createHash } = await import("node:crypto");
  return {
    publishDraft: async (options: DraftOptions) => {
      const hashes: Record<string, string> = {};
      for (const path of options.files)
        hashes[basename(path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      edges.publications.push({ options, hashes });
      return { url: `https://github.com/${options.repository}/releases/tag/${options.tag}` };
    },
  };
});

const temporary: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
beforeEach(() => {
  edges.signed.length = 0;
  edges.publications.length = 0;
  vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", "controlled-signing-edge");
  vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY_PATH", undefined);
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-finalize-"));
  temporary.push(directory);
  return directory;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function streamServer(): Promise<{ url: string; bytes: Buffer }> {
  const bytes = Buffer.from([0, 255, 1, 128, 2, 64, 3, 32]);
  const server = createServer((request, response) => {
    switch (request.url) {
      case "/exact":
        response.write(bytes.subarray(0, 3));
        response.write(bytes.subarray(3, 6));
        response.end(bytes.subarray(6));
        break;
      case "/truncated":
        response.end(bytes.subarray(0, bytes.length - 1));
        break;
      case "/tampered": {
        const changed = Buffer.from(bytes);
        changed[0] = changed[0]! ^ 1;
        response.end(changed);
        break;
      }
      case "/oversize":
        response.end(Buffer.concat([bytes, Buffer.from([4])]));
        break;
      default:
        response.writeHead(503);
        response.end("upstream unavailable");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { url: `http://127.0.0.1:${address.port}`, bytes };
}

async function publication(targets: ReleaseTarget[] = ["windows-x64"]) {
  const directory = await workspace();
  const runtime = join(directory, "runtime");
  await mkdir(runtime);
  for (const [target, pin] of Object.entries(NODE_PIN.targets))
    await writeFile(
      join(runtime, basename(new URL(pin.url).pathname)),
      `controlled upstream archive ${target}`,
    );
  const artifact = async (target: ReleaseTarget, component: string): Promise<ReleaseArtifact> => {
    const name = `${target}-${component}.bin`;
    const path = join(directory, name);
    await writeFile(path, `controlled ${target} ${component}`);
    return {
      url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${PRODUCT_VERSION}/${name}`,
      ...(await fileIdentity(path)),
      format: "file",
      root: component,
      entry: name,
    };
  };
  const manifest: ReleaseManifest = {
    formatVersion: 1,
    productVersion: PRODUCT_VERSION,
    sourceCommit: edges.sourceCommit,
    managementVersion: 1,
    protocolVersion: 4,
    storeSchemaVersion: 4,
    pluginContracts: { approval: "1" },
    targets: {},
  };
  for (const target of targets) {
    const desktop = await artifact(target, "desktop");
    manifest.targets[target] = {
      minimumPlatform: "controlled platform",
      node: {
        version: NODE_PIN.version,
        artifact: artifactSchema.parse({
          ...NODE_PIN.targets[target],
          url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/runtime-node-${NODE_PIN.version}/${basename(new URL(NODE_PIN.targets[target].url).pathname)}`,
        }),
      },
      server: await artifact(target, "server"),
      cli: await artifact(target, "cli"),
      launcher: await artifact(target, "launcher"),
      desktop,
      desktopUpdate: { artifact: desktop, signature: `controlled:${desktop.sha256}` },
    };
  }
  const source = {
    productVersion: PRODUCT_VERSION,
    sourceCommit: edges.sourceCommit,
    missingNotices: [] as string[],
    npmPreferredSourceComplete: true,
  };
  await writeFile(join(directory, "release.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "latest.json"), JSON.stringify(updaterMetadata(manifest)));
  await writeFile(join(directory, "source.json"), JSON.stringify(source));
  await writeFile(join(directory, `harness-${PRODUCT_VERSION}-source.tar.gz`), "controlled source");
  await writeFile(join(directory, `harness-${PRODUCT_VERSION}-notices.txt`), "controlled notices");
  return { directory, runtime, manifest, source };
}

describe("bounded runtime downloads", () => {
  it("streams exact binary bytes through real HTTP to a verified local file", async () => {
    const { url, bytes } = await streamServer();
    const directory = await workspace();
    const path = join(directory, "runtime.zip");
    await downloadRuntime(`${url}/exact`, bytes.length, digest(bytes), path);
    expect(await readFile(path)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(["runtime.zip"]);
  });

  it.each(["truncated", "tampered", "oversize", "http-error"])(
    "rejects a %s response and removes only this attempt's file",
    async (route) => {
      const { url, bytes } = await streamServer();
      const directory = await workspace();
      const path = join(directory, "runtime.zip");
      await writeFile(join(directory, "sentinel"), "preserve unrelated bytes");
      await expect(
        downloadRuntime(`${url}/${route}`, bytes.length, digest(bytes), path),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["sentinel"]);
      expect(await readFile(join(directory, "sentinel"), "utf8")).toBe("preserve unrelated bytes");
    },
  );

  it("removes a partial file after the response stream fails", async () => {
    const directory = await workspace();
    const path = join(directory, "runtime.zip");
    const bytes = Buffer.from("complete runtime");
    const failure = new Error("Controlled body read failed");
    let pulls = 0;
    const request: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 3));
            else controller.error(failure);
          },
        }),
      );
    await expect(
      downloadRuntime(
        "https://example.invalid/runtime",
        bytes.length,
        digest(bytes),
        path,
        request,
      ),
    ).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves an existing destination even when the downloaded bytes are correct", async () => {
    const { url, bytes } = await streamServer();
    const directory = await workspace();
    const path = join(directory, "runtime.zip");
    await writeFile(path, "existing complete download");
    await expect(
      downloadRuntime(`${url}/exact`, bytes.length, digest(bytes), path),
    ).rejects.toThrow("EEXIST");
    expect(await readFile(path, "utf8")).toBe("existing complete download");
  });
});

describe("publication signing and gates", () => {
  it("seals both complete local sets and reuses their signatures without a signing key", async () => {
    const { directory, runtime } = await publication();
    await signPublication(directory);
    const manifestSignature = await readFile(join(directory, "release.json.sig"));
    expect(await readFile(join(directory, "release.json.minisig"))).toEqual(manifestSignature);
    const before = new Map<string, Buffer>();
    for (const group of [directory, runtime]) {
      const checksums = await readFile(join(group, "checksums.txt"), "utf8");
      expect(checksums).not.toMatch(/ {2}checksums\.txt(?:\.sig)?\n/u);
      for (const line of checksums.trimEnd().split("\n")) {
        const [hash, name] = line.split("  ");
        expect(hash).toBe(digest(await readFile(join(group, name!))));
      }
      before.set(
        join(group, "checksums.txt.sig"),
        await readFile(join(group, "checksums.txt.sig")),
      );
    }
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", undefined);
    await signPublication(directory);
    expect(await readFile(join(directory, "release.json.sig"))).toEqual(manifestSignature);
    for (const [path, bytes] of before) expect(await readFile(path)).toEqual(bytes);
    expect(edges.publications).toEqual([]);
  });

  it("requires a signing key for a new set without creating a fake signature", async () => {
    const { directory } = await publication();
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", undefined);
    await expect(signPublication(directory)).rejects.toThrow("Project signing key is required");
    expect(await readdir(directory)).not.toContain("release.json.sig");
    expect(edges.publications).toEqual([]);
  });

  it.each(["product", "runtime", "manifest", "checksum-signature"])(
    "excludes %s tampering from publication and preserves existing seals",
    async (part) => {
      const { directory, runtime } = await publication();
      await signPublication(directory);
      const seal = await readFile(join(directory, "checksums.txt"));
      const path =
        part === "runtime"
          ? join(runtime, basename(new URL(NODE_PIN.targets["windows-x64"].url).pathname))
          : join(
              directory,
              part === "product"
                ? "windows-x64-launcher.bin"
                : part === "manifest"
                  ? "release.json"
                  : "checksums.txt.sig",
            );
      await writeFile(path, "changed after sealing");
      await expect(publishPublication(directory, "windows-preview")).rejects.toThrow();
      expect(edges.publications).toEqual([]);
      expect(await readFile(join(directory, "checksums.txt"))).toEqual(seal);
      if (part === "product") await expect(signPublication(directory)).rejects.toThrow();
    },
  );

  it("refuses conflicting existing manifest signatures instead of overwriting them", async () => {
    const { directory } = await publication();
    await signPublication(directory);
    const path = join(directory, "release.json.minisig");
    await writeFile(path, "different signature");
    await expect(signPublication(directory)).rejects.toThrow("Existing manifest signatures differ");
    expect(await readFile(path, "utf8")).toBe("different signature");
    expect(edges.publications).toEqual([]);
  });

  it.each(["stable", "unknown-channel"])(
    "rejects an incomplete or unsupported channel (%s) before GitHub mutations",
    async (channel) => {
      const { directory } = await publication();
      await signPublication(directory);
      await expect(publishPublication(directory, channel)).rejects.toThrow();
      expect(edges.publications).toEqual([]);
    },
  );

  it.each(["missing-notices", "incomplete-npm-source", "wrong-source-identity"])(
    "keeps the unresolved source gate closed (%s) before GitHub mutations",
    async (condition) => {
      const { directory, source } = await publication();
      if (condition === "missing-notices") source.missingNotices = ["dependency"];
      if (condition === "incomplete-npm-source") source.npmPreferredSourceComplete = false;
      if (condition === "wrong-source-identity") source.sourceCommit = "b".repeat(40);
      await writeFile(join(directory, "source.json"), JSON.stringify(source));
      if (condition === "wrong-source-identity")
        await expect(signPublication(directory)).rejects.toThrow("source identity differs");
      else {
        await signPublication(directory);
        await expect(publishPublication(directory, "windows-preview")).rejects.toThrow();
      }
      expect(edges.publications).toEqual([]);
    },
  );

  it("rejects a mismatched source export before preparing publication output", async () => {
    const { directory, source } = await publication();
    source.productVersion = "99.0.0";
    await writeFile(join(directory, "source.json"), JSON.stringify(source));
    const output = join(directory, "prepared");
    await expect(preparePublication(directory, output, ["windows-x64"], directory)).rejects.toThrow(
      "Source export differs",
    );
    await expect(readdir(output)).rejects.toThrow("ENOENT");
    expect(edges.publications).toEqual([]);
  });

  it.each([
    "windows-x64-launcher.bin",
    `harness-${PRODUCT_VERSION}-source.tar.gz`,
    `harness-${PRODUCT_VERSION}-notices.txt`,
  ])("refuses to seal an incomplete local set missing %s", async (name) => {
    const { directory } = await publication();
    await rm(join(directory, name));
    await expect(signPublication(directory)).rejects.toThrow("ENOENT");
    expect(edges.signed).toEqual([]);
    expect(edges.publications).toEqual([]);
  });
});

describe("complete publication channels", () => {
  it.each(["windows-preview", "stable"])(
    "publishes %s with separate immutable runtime assets and the intended latest policy",
    async (channel) => {
      const targets =
        channel === "stable"
          ? (Object.keys(NODE_PIN.targets) as ReleaseTarget[])
          : ["windows-x64" as const];
      const { directory } = await publication(targets);
      await signPublication(directory);
      await publishPublication(directory, channel);
      const runtime = edges.publications.find(
        ({ options }) => options.tag === `runtime-node-${NODE_PIN.version}`,
      )!;
      const product = edges.publications.find(
        ({ options }) => options.tag === `v${PRODUCT_VERSION}`,
      )!;
      expect(edges.publications).toHaveLength(2);
      expect(runtime.options).toMatchObject({
        latest: false,
        prerelease: false,
        repository: RELEASE_REPOSITORY,
      });
      expect(runtime.options.files.map((path) => basename(path)).sort()).toEqual(
        Object.values(NODE_PIN.targets)
          .map((pin) => basename(new URL(pin.url).pathname))
          .sort(),
      );
      expect(runtime.options.files).toHaveLength(4);
      for (const pin of Object.values(NODE_PIN.targets))
        expect(runtime.hashes[basename(new URL(pin.url).pathname)]).toBe(pin.sha256);
      expect(product.options).toMatchObject({
        latest: channel === "stable",
        prerelease: channel === "windows-preview",
        repository: RELEASE_REPOSITORY,
      });
      const expected = (await readdir(directory)).filter((name) => name !== "runtime").sort();
      expect(product.options.files.map((path) => basename(path)).sort()).toEqual(expected);
      expect(expected).toContain(`harness-${PRODUCT_VERSION}-source.tar.gz`);
      expect(expected).toContain(`harness-${PRODUCT_VERSION}-notices.txt`);
      expect(expected).toContain("release.json.minisig");
      expect(expected).toContain("checksums.txt.sig");
    },
  );
});
