import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compareVersions, targetSchema, versionSchema } from "@harness/release";
import { replaceJson } from "./json-file.ts";

/** One immutable payload directory, never a path or a live process identity. */
export const serverCacheEntrySchema = z
  .string()
  .max(256)
  .refine((value) => {
    for (const target of targetSchema.options) {
      if (new RegExp(`^dev-${target}-[a-f0-9]{64}$`, "u").test(value)) return true;
      const suffix = `-${target}`;
      if (value.endsWith(suffix) && versionSchema.safeParse(value.slice(0, -suffix.length)).success)
        return true;
    }
    return false;
  }, "Expected an immutable server cache directory name");

export const serverSelectionSchema = z.strictObject({
  formatVersion: z.literal(1),
  directory: serverCacheEntrySchema,
});
export type ServerSelection = z.infer<typeof serverSelectionSchema>;

const selectionPath = (home: string) => join(home, "server", "current.json");

/** Source builds have no release ordering. The directory has already been validated. */
export function serverReleaseVersion(directory: string): string | undefined {
  if (directory.startsWith("dev-")) return undefined;
  const target = targetSchema.options.find((target) => directory.endsWith(`-${target}`));
  if (target === undefined) throw new Error("Server cache entry has no supported target");
  return directory.slice(0, -target.length - 1);
}

export async function readServerSelection(home: string): Promise<ServerSelection | null> {
  try {
    return serverSelectionSchema.parse(JSON.parse(await readFile(selectionPath(home), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The caller holds the home lifecycle lock and the target's cache-use protection. */
export async function selectInitialServer(home: string, directory: string): Promise<void> {
  const candidate = serverSelectionSchema.parse({ formatVersion: 1, directory });
  const selected = await readServerSelection(home);
  if (selected !== null) {
    if (selected.directory === candidate.directory) return;
    // The caller has retired the previous owner before changing its selection.
    const target = targetSchema.options.find((target) => selected.directory.endsWith(`-${target}`));
    const previousVersion = serverReleaseVersion(selected.directory);
    const nextVersion = serverReleaseVersion(candidate.directory);
    const sourceTarget = targetSchema.options.find((target) =>
      selected.directory.startsWith(`dev-${target}-`),
    );
    const sourceRebuild =
      sourceTarget !== undefined && candidate.directory.startsWith(`dev-${sourceTarget}-`);
    const releaseUpgrade =
      target !== undefined &&
      candidate.directory.endsWith(`-${target}`) &&
      previousVersion !== undefined &&
      nextVersion !== undefined &&
      compareVersions(nextVersion, previousVersion) > 0;
    if (!sourceRebuild && !releaseUpgrade)
      throw new Error("Selected server changed; prepare the selected version and reconnect");
  }
  await mkdir(join(home, "server"), { recursive: true, mode: 0o700 });
  await replaceJson(selectionPath(home), candidate);
}

/** Run after SQLite exclusion and before schema initialization; no asynchronous gap. */
export function assertSelectedServer(home: string, expectedDirectory?: string): void {
  let selected: ServerSelection;
  try {
    selected = serverSelectionSchema.parse(JSON.parse(readFileSync(selectionPath(home), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (expectedDirectory === undefined) return; // Direct source runs have no managed selection.
    throw new Error("Managed server selection is missing; start through a Harness client", {
      cause: error,
    });
  }
  if (selected.directory !== expectedDirectory)
    throw new Error("This server build is no longer selected; reconnect through a Harness client");
}
