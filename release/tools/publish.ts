import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { fileIdentity } from "./artifacts.ts";

export type GithubCommand = (args: string[]) => Promise<string>;
const execute = promisify(execFile);
const github: GithubCommand = async (args) =>
  (await execute("gh", args, { windowsHide: true, maxBuffer: 8 * 1024 ** 2 })).stdout;
const releaseSchema = z.object({
  databaseId: z.number().int().positive(),
  tagName: z.string(),
  name: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  isImmutable: z.boolean(),
  isPrerelease: z.boolean(),
  url: z.url(),
});
const assetSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  state: z.literal("uploaded"),
  digest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable(),
});
const nameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/u);

export interface DraftOptions {
  repository: string;
  tag: string;
  title: string;
  notes: string;
  files: string[];
  latest: boolean;
  prerelease: boolean;
}

/** One publisher owns the finished set. Existing bytes are compared, never
 * clobbered; retrying a failed publication uses the same draft and same files. */
export async function publishDraft(
  options: DraftOptions,
  run: GithubCommand = github,
): Promise<{ url: string; alreadyPublished: boolean }> {
  z.string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .parse(options.repository);
  nameSchema.parse(options.tag);
  if (options.files.length === 0 || options.files.length > 1000)
    throw new Error("A complete nonempty release asset set is required");
  if (options.latest && options.prerelease)
    throw new Error("A preview cannot become stable latest");
  const files = new Map<string, { path: string; size: number; sha256: string }>();
  for (const path of options.files) {
    const name = nameSchema.parse(basename(path));
    if (files.has(name)) throw new Error(`Duplicate publication asset: ${name}`);
    files.set(name, { path, ...(await fileIdentity(path)) });
  }
  // Check configuration, never silently change repository settings in a release.
  z.object({ enabled: z.literal(true) }).parse(
    JSON.parse(
      await run([
        "api",
        `repos/${options.repository}/immutable-releases`,
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ]),
    ),
  );
  const scratch = await mkdtemp(join(tmpdir(), "harness-release-publish-"));
  try {
    const view = async () =>
      releaseSchema.parse(
        JSON.parse(
          await run([
            "release",
            "view",
            options.tag,
            "--repo",
            options.repository,
            "--json",
            "databaseId,tagName,name,body,isDraft,isImmutable,isPrerelease,url",
          ]),
        ),
      );
    let release;
    try {
      release = await view();
    } catch (error) {
      // gh classifies a missing tag distinctly. Auth/network/API failures must
      // propagate, rather than creating another logical publication attempt.
      if (
        !error ||
        typeof error !== "object" ||
        !("stderr" in error) ||
        typeof error.stderr !== "string" ||
        !/^release not found\s*$/iu.test(error.stderr)
      )
        throw error;
      const notes = join(scratch, "notes.md");
      await writeFile(notes, options.notes);
      await run([
        "release",
        "create",
        options.tag,
        "--repo",
        options.repository,
        "--draft",
        "--latest=false",
        "--title",
        options.title,
        "--notes-file",
        notes,
        ...(options.prerelease ? ["--prerelease"] : []),
      ]);
      release = await view();
    }
    if (
      release.tagName !== options.tag ||
      release.name !== options.title ||
      release.body !== options.notes ||
      release.isPrerelease !== options.prerelease
    )
      throw new Error("Existing release describes a different publication intent");
    const assets = async () =>
      z
        .array(z.array(assetSchema))
        .parse(
          JSON.parse(
            await run([
              "api",
              `repos/${options.repository}/releases/${release.databaseId}/assets?per_page=100`,
              "--paginate",
              "--slurp",
              "-H",
              "X-GitHub-Api-Version: 2026-03-10",
            ]),
          ),
        )
        .flat();
    const verify = async (items: z.infer<typeof assetSchema>[]) => {
      if (items.length > 1000 || new Set(items.map((item) => item.name)).size !== items.length)
        throw new Error("Release assets exceed their bound or contain duplicate names");
      for (const item of items) {
        const file = files.get(item.name);
        if (!file) throw new Error(`Unexpected existing release asset: ${item.name}`);
        if (item.size !== file.size) throw new Error(`Existing release bytes differ: ${item.name}`);
        if (item.digest !== null) {
          if (item.digest !== `sha256:${file.sha256}`)
            throw new Error(`Existing release bytes differ: ${item.name}`);
        } else {
          // GitHub assets uploaded before digest support may have no checksum.
          // Download those exact bytes through gh, without carrying credentials
          // to an arbitrary URL taken from metadata.
          await run([
            "release",
            "download",
            options.tag,
            "--repo",
            options.repository,
            "--pattern",
            item.name,
            "--dir",
            scratch,
          ]);
          const downloaded = await fileIdentity(join(scratch, item.name));
          if (downloaded.sha256 !== file.sha256 || downloaded.size !== file.size)
            throw new Error(`Existing release bytes differ: ${item.name}`);
          await rm(join(scratch, item.name));
        }
      }
    };
    const current = await assets();
    await verify(current);
    const present = new Set(current.map((item) => item.name));
    if (!release.isDraft) {
      if (!release.isImmutable || present.size !== files.size)
        throw new Error("Published release is mutable or incomplete; it cannot be overwritten");
      return { url: release.url, alreadyPublished: true };
    }
    for (const [name, file] of files)
      if (!present.has(name))
        await run(["release", "upload", options.tag, file.path, "--repo", options.repository]);
    const complete = await assets();
    await verify(complete);
    if (complete.length !== files.size) throw new Error("Draft asset set is incomplete");
    await run([
      "release",
      "edit",
      options.tag,
      "--repo",
      options.repository,
      "--draft=false",
      `--latest=${String(options.latest)}`,
    ]);
    const published = await view();
    if (published.isDraft || !published.isImmutable)
      throw new Error("GitHub did not confirm an immutable published release");
    return { url: published.url, alreadyPublished: false };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
