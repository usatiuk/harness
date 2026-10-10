import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishDraft,
  type DraftOptions,
  type GithubCommand,
} from "../../../release/tools/publish.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Release {
  databaseId: number;
  tagName: string;
  name: string;
  body: string;
  isDraft: boolean;
  isImmutable: boolean;
  isPrerelease: boolean;
  url: string;
}

interface Asset {
  name: string;
  size: number;
  state: "uploaded";
  digest: string | null;
  bytes: Buffer;
}

function asset(name: string, bytes: string | Buffer, digest = true): Asset {
  const content = Buffer.from(bytes);
  return {
    name,
    size: content.length,
    state: "uploaded",
    digest: digest ? `sha256:${createHash("sha256").update(content).digest("hex")}` : null,
    bytes: content,
  };
}

function release(options: DraftOptions, overrides: Partial<Release> = {}): Release {
  return {
    databaseId: 42,
    tagName: options.tag,
    name: options.title,
    body: options.notes,
    isDraft: true,
    isImmutable: false,
    isPrerelease: options.prerelease,
    url: `https://github.com/${options.repository}/releases/tag/${options.tag}`,
    ...overrides,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-release-publisher-"));
  temporary.push(directory);
  const sources = [
    asset("harness.exe", "native launcher"),
    asset("release.json", "signed metadata"),
  ];
  for (const source of sources) await writeFile(join(directory, source.name), source.bytes);
  const options: DraftOptions = {
    repository: "example/harness",
    tag: "v1.2.3",
    title: "Harness 1.2.3",
    notes: "First paragraph.\n\nSecond paragraph with literal `$(text)`.\n",
    files: sources.map((source) => join(directory, source.name)),
    latest: true,
    prerelease: false,
  };
  const state = {
    release: null as Release | null,
    assets: [] as Asset[],
    immutableSetting: { enabled: true } as unknown,
    mutations: [] as { kind: "create" | "upload" | "publish"; name?: string }[],
    downloads: [] as string[],
    latest: false,
    keepDraft: false,
    immutableOnPublish: true,
    viewFailure: null as Error | null,
    uploadFailure: null as { name: string; error: Error } | null,
  };
  const value = (args: string[], flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) throw new Error(`Missing fixture argument: ${flag}`);
    return args[index + 1]!;
  };
  // Only the GitHub process edge is controlled. Local inputs, hashes, notes-file
  // reads and legacy asset downloads use real files; the edge refuses clobbering.
  const run: GithubCommand = async (args) => {
    if (args[0] === "api" && args[1]?.endsWith("/immutable-releases"))
      return JSON.stringify(state.immutableSetting);
    if (args[0] === "api" && args[1]?.includes("/assets?"))
      return JSON.stringify([
        state.assets.map(({ name, size, state: assetState, digest }) => ({
          name,
          size,
          state: assetState,
          digest,
        })),
      ]);
    if (args[0] !== "release") throw new Error(`Unknown fixture command: ${args.join(" ")}`);
    switch (args[1]) {
      case "view": {
        if (state.viewFailure) throw state.viewFailure;
        if (!state.release)
          throw Object.assign(new Error("Missing release"), { stderr: "release not found\n" });
        return JSON.stringify(state.release);
      }
      case "create": {
        if (state.release) throw new Error("Fixture refuses to replace a release");
        if (!args.includes("--draft") || !args.includes("--latest=false"))
          throw new Error("Release must begin as a draft without becoming latest");
        state.release = release(options, {
          tagName: args[2]!,
          name: value(args, "--title"),
          body: await readFile(value(args, "--notes-file"), "utf8"),
          isPrerelease: args.includes("--prerelease"),
        });
        state.mutations.push({ kind: "create" });
        return state.release.url;
      }
      case "upload": {
        const path = args[3]!;
        const name = basename(path);
        if (args.includes("--clobber") || state.assets.some((item) => item.name === name))
          throw new Error("Fixture refuses asset clobbering");
        if (state.uploadFailure?.name === name) throw state.uploadFailure.error;
        state.assets.push(asset(name, await readFile(path)));
        state.mutations.push({ kind: "upload", name });
        return "";
      }
      case "download": {
        const item = state.assets.find((candidate) => candidate.name === value(args, "--pattern"));
        if (!item) throw new Error("Missing fixture asset");
        const path = join(value(args, "--dir"), item.name);
        await writeFile(path, item.bytes, { flag: "wx" });
        state.downloads.push(path);
        return "";
      }
      case "edit": {
        if (!state.release?.isDraft) throw new Error("Fixture refuses editing a published release");
        if (!args.includes("--draft=false")) throw new Error("Missing publication request");
        state.release.isDraft = state.keepDraft;
        state.release.isImmutable = state.immutableOnPublish;
        state.latest = args.includes("--latest=true");
        state.mutations.push({ kind: "publish" });
        return "";
      }
      default:
        throw new Error(`Unknown fixture command: ${args.join(" ")}`);
    }
  };
  return { directory, options, sources, state, run };
}

describe("GitHub release publication", () => {
  it("creates and publishes a complete immutable release with exact notes and bytes", async () => {
    const { options, sources, state, run } = await fixture();
    const result = await publishDraft(options, run);
    expect(result).toEqual({ url: state.release!.url, alreadyPublished: false });
    expect(state.release).toMatchObject({
      tagName: options.tag,
      name: options.title,
      body: options.notes,
      isDraft: false,
      isImmutable: true,
      isPrerelease: false,
    });
    expect(state.assets).toEqual(sources);
    expect(state.latest).toBe(true);
  });

  it("reuses a partial draft and preserves its already uploaded bytes", async () => {
    const { options, sources, state, run } = await fixture();
    state.release = release(options);
    const existing = sources[0]!;
    state.assets = [existing];
    await expect(publishDraft(options, run)).resolves.toMatchObject({ alreadyPublished: false });
    expect(state.assets).toEqual(sources);
    expect(state.assets[0]).toBe(existing);
    expect(state.mutations).not.toContainEqual({ kind: "create" });
    expect(state.release.isImmutable).toBe(true);
  });

  it("retries interrupted uploads through the same draft without replacing successful assets", async () => {
    const { options, sources, state, run } = await fixture();
    const failure = new Error("Upload transport failed");
    state.uploadFailure = { name: sources[1]!.name, error: failure };
    await expect(publishDraft(options, run)).rejects.toBe(failure);
    const originalDraft = state.release;
    const uploaded = state.assets[0];
    expect(state.assets).toEqual([sources[0]]);
    expect(state.release?.isDraft).toBe(true);
    state.uploadFailure = null;
    await expect(publishDraft(options, run)).resolves.toMatchObject({ alreadyPublished: false });
    expect(state.release).toBe(originalDraft);
    expect(state.assets).toEqual(sources);
    expect(state.assets[0]).toBe(uploaded);
    expect(state.release?.isImmutable).toBe(true);
  });

  it.each(["digest", "size"] as const)(
    "rejects existing bytes with a different %s without overwriting them",
    async (field) => {
      const { options, sources, state, run } = await fixture();
      state.release = release(options);
      const conflicting = asset(sources[0]!.name, field === "size" ? "short" : "random launcher");
      if (field === "size") conflicting.digest = sources[0]!.digest;
      else conflicting.size = sources[0]!.size;
      state.assets = [conflicting];
      await expect(publishDraft(options, run)).rejects.toThrow("Existing release bytes differ");
      expect(state.assets).toEqual([conflicting]);
      expect(state.mutations).toEqual([]);
      expect(state.release.isDraft).toBe(true);
    },
  );

  it("refuses unknown assets instead of deleting or replacing them", async () => {
    const { options, sources, state, run } = await fixture();
    state.release = release(options);
    const unexpected = asset("other-version.exe", "other release");
    state.assets = [...sources, unexpected];
    await expect(publishDraft(options, run)).rejects.toThrow("Unexpected existing release asset");
    expect(state.assets).toEqual([...sources, unexpected]);
    expect(state.mutations).toEqual([]);
  });

  it("accepts a complete immutable retry without changing the published release", async () => {
    const { options, sources, state, run } = await fixture();
    state.release = release(options, { isDraft: false, isImmutable: true });
    state.assets = [...sources];
    const original = structuredClone(state.release);
    await expect(publishDraft(options, run)).resolves.toEqual({
      url: state.release.url,
      alreadyPublished: true,
    });
    expect(state.release).toEqual(original);
    expect(state.assets).toEqual(sources);
    expect(state.mutations).toEqual([]);
  });

  it.each(["mutable", "incomplete"])(
    "rejects an already published %s release without trying to repair it",
    async (condition) => {
      const { options, sources, state, run } = await fixture();
      state.release = release(options, { isDraft: false, isImmutable: condition !== "mutable" });
      state.assets = condition === "incomplete" ? [sources[0]!] : [...sources];
      const original = state.assets.map((item) => ({ ...item, bytes: Buffer.from(item.bytes) }));
      await expect(publishDraft(options, run)).rejects.toThrow("cannot be overwritten");
      expect(state.assets).toEqual(original);
      expect(state.mutations).toEqual([]);
    },
  );

  it.each([{}, { enabled: false }, { enabled: "true" }])(
    "requires an explicitly enabled immutable-release setting (%j)",
    async (setting) => {
      const { options, state, run } = await fixture();
      state.immutableSetting = setting;
      await expect(publishDraft(options, run)).rejects.toThrow();
      expect(state.release).toBeNull();
      expect(state.assets).toEqual([]);
      expect(state.mutations).toEqual([]);
    },
  );

  it("propagates immutable-setting API failure without creating a draft", async () => {
    const { options, state } = await fixture();
    const failure = new Error("API authentication failed");
    await expect(
      publishDraft(options, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(state.mutations).toEqual([]);
  });

  it.each([
    "HTTP 401: authentication required",
    "connection timed out",
    "release not found\nHTTP 503",
  ])("does not mistake a release-view failure for a missing release (%s)", async (stderr) => {
    const { options, state, run } = await fixture();
    const failure = Object.assign(new Error("GitHub command failed"), { stderr });
    state.viewFailure = failure;
    await expect(publishDraft(options, run)).rejects.toBe(failure);
    expect(state.release).toBeNull();
    expect(state.mutations).toEqual([]);
  });

  it("downloads and verifies old null-digest assets, then removes temporary downloads", async () => {
    const { options, sources, state, run } = await fixture();
    state.release = release(options);
    const existing = { ...sources[0]!, digest: null };
    state.assets = [existing];
    await expect(publishDraft(options, run)).resolves.toMatchObject({ alreadyPublished: false });
    expect(state.assets).toEqual([existing, sources[1]]);
    expect(state.assets[0]).toBe(existing);
    expect(state.downloads.length).toBeGreaterThan(0);
    for (const path of state.downloads) await expect(readFile(path)).rejects.toThrow("ENOENT");
    expect(state.release.isImmutable).toBe(true);
  });

  it("rejects differing old null-digest bytes even when the reported size matches", async () => {
    const { options, sources, state, run } = await fixture();
    state.release = release(options);
    const conflicting = asset(sources[0]!.name, "random launcher", false);
    conflicting.size = sources[0]!.size;
    state.assets = [conflicting];
    await expect(publishDraft(options, run)).rejects.toThrow("Existing release bytes differ");
    expect(state.assets).toEqual([conflicting]);
    expect(state.downloads.length).toBeGreaterThan(0);
    for (const path of state.downloads) await expect(readFile(path)).rejects.toThrow("ENOENT");
    expect(state.mutations).toEqual([]);
  });

  it.each(["still-draft", "mutable"])(
    "requires GitHub to confirm immutable publication (%s)",
    async (condition) => {
      const { options, sources, state, run } = await fixture();
      state.keepDraft = condition === "still-draft";
      state.immutableOnPublish = condition !== "mutable";
      await expect(publishDraft(options, run)).rejects.toThrow("did not confirm");
      expect(state.assets).toEqual(sources);
      expect(state.mutations).toContainEqual({ kind: "publish" });
    },
  );

  it("publishes runtime releases without selecting them as latest", async () => {
    const { options, state, run } = await fixture();
    options.tag = "runtime-node-22.23.3";
    options.latest = false;
    await publishDraft(options, run);
    expect(state.release?.isImmutable).toBe(true);
    expect(state.latest).toBe(false);
  });

  it("rejects different existing publication intent without changing its draft", async () => {
    const { options, state, run } = await fixture();
    state.release = release(options, { body: "Different release notes" });
    await expect(publishDraft(options, run)).rejects.toThrow("different publication intent");
    expect(state.release.body).toBe("Different release notes");
    expect(state.mutations).toEqual([]);
  });

  it("rejects duplicate local asset names before publication", async () => {
    const { directory, options, state, run } = await fixture();
    const duplicate = join(directory, "another", basename(options.files[0]!));
    await mkdir(join(directory, "another"));
    await writeFile(duplicate, "different bytes");
    options.files.push(duplicate);
    await expect(publishDraft(options, run)).rejects.toThrow("Duplicate publication asset");
    expect(state.release).toBeNull();
    expect(state.mutations).toEqual([]);
  });
});
