import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import type { ConversationConfig } from "@harness/protocol";
import { deepMerge } from "./merge.ts";
import { defaultHome } from "./home.ts";
import {
  formatIssue,
  decodeSettingsFile,
  parseProjectDoc,
  parseSettingsDoc,
  projectDocSchema,
  settingsDocSchema,
  type SettingsDoc,
} from "./settings.ts";

export interface ResolveOptions {
  /** Harness home directory; the global layer is `<home>/settings.json`. */
  home: string;
  /** Lowest-precedence base layer, below global settings (e.g. a CLI fallback model). */
  defaults?: SettingsDoc;
  /** Where the project search starts. Absent ⇒ projectless (project layers skipped). */
  cwd?: string;
  /** Named profile to overlay above the project layers. */
  profile?: string;
  /**
   * Programmatic top layer (highest precedence), e.g. a conversation's durable `overrides`. Opaque
   * (`Record<string, unknown>`) because it comes from durable storage; validated here as a
   * `SettingsDoc` before it joins the cascade.
   */
  overrides?: Record<string, unknown>;
  /** Plugin id → config schema, for central validation of plugin slices. */
  schemas: Map<string, ZodType>;
  globalPlugins?: ReadonlySet<string>;
}

/** One labelled layer in the cascade; the label cites the source in errors. */
interface Layer {
  label: string;
  doc: SettingsDoc;
}

/**
 * Collapses the settings cascade into a `ConversationConfig`:
 * `global < project-shared < project-local < profile < overrides`. Validates the
 * kernel doc per file and each plugin slice against its schema; unknown plugins and
 * unknown keys fail fast, citing the source file.
 */
export async function resolveSettings(opts: ResolveOptions): Promise<ConversationConfig> {
  const root = opts.cwd ? await findProjectRoot(opts.cwd, opts.home) : undefined;

  const layers: Layer[] = [];
  if (opts.defaults !== undefined) layers.push({ label: "defaults", doc: opts.defaults });
  await pushFileLayer(
    layers,
    "global settings",
    join(opts.home, "settings.json"),
    settingsDocSchema,
  );
  if (root && !(await isHomeRoot(root, opts.home))) {
    await pushFileLayer(
      layers,
      "project settings",
      join(root, ".harness", "settings.json"),
      projectDocSchema,
    );
    await pushFileLayer(
      layers,
      "local settings",
      join(root, ".harness", "settings.local.json"),
      projectDocSchema,
    );
  }

  if (opts.profile !== undefined) {
    const profile = mergeDocs(layers).profiles?.[opts.profile];
    if (!profile) throw new Error(`unknown profile: ${opts.profile}`);
    layers.push({ label: `profile '${opts.profile}'`, doc: profile });
  }
  if (opts.overrides !== undefined) {
    const parsed = projectDocSchema.safeParse(opts.overrides);
    if (!parsed.success) throw new Error(`invalid overrides: ${formatIssue(parsed.error)}`);
    layers.push({ label: "overrides", doc: parsed.data });
  }

  for (const layer of layers) {
    validateGlobalPluginScopes(
      layer.doc,
      opts.globalPlugins ?? new Set(),
      layer.label,
      layer.label === "defaults" || layer.label.startsWith("global settings ("),
    );
  }
  const doc = mergeDocs(layers);
  const sources = pluginSources(layers);

  if (!doc.model) {
    throw new Error("no model configured (set `model` in settings or pass it as an override)");
  }

  return {
    instructions: doc.instructions ?? "",
    ...(doc.compaction ? { compaction: doc.compaction } : {}),
    model: {
      provider: doc.model.provider,
      model: doc.model.model,
      ...(doc.model.preset ? { preset: doc.model.preset } : {}),
    },
    ...(doc.tools
      ? {
          tools: {
            ...(doc.tools.allow !== undefined ? { allow: doc.tools.allow } : {}),
            ...(doc.tools.mode !== undefined ? { mode: doc.tools.mode } : {}),
          },
        }
      : {}),
    plugins: resolvePlugins(doc.plugins ?? {}, opts.schemas, sources),
  };
}

/**
 * Merges only the file layers of the cascade — `global < project < local` — into a raw settings
 * doc, skipping the model requirement and the programmatic layers (defaults/profile/overrides). For
 * readers that need a single setting (e.g. the sandbox CLI resolving `configPath`) without building
 * a full `ConversationConfig`. Reuses the same layer primitives as `resolveSettings`.
 */
export async function loadMergedSettings(home: string, cwd?: string): Promise<SettingsDoc> {
  const root = cwd ? await findProjectRoot(cwd, home) : undefined;
  const layers: Layer[] = [];
  await pushFileLayer(layers, "global settings", join(home, "settings.json"), settingsDocSchema);
  if (root && !(await isHomeRoot(root, home))) {
    await pushFileLayer(
      layers,
      "project settings",
      join(root, ".harness", "settings.json"),
      projectDocSchema,
    );
    await pushFileLayer(
      layers,
      "local settings",
      join(root, ".harness", "settings.local.json"),
      projectDocSchema,
    );
  }
  return mergeDocs(layers);
}

/** Validates each plugin slice against its schema (applying defaults); rejects unknowns. */
function resolvePlugins(
  raw: Record<string, unknown>,
  schemas: Map<string, ZodType>,
  sources: Map<string, string>,
): Record<string, unknown> {
  for (const id of Object.keys(raw)) {
    if (!schemas.has(id)) {
      throw new Error(`unknown plugin '${id}' (in ${sources.get(id) ?? "settings"})`);
    }
  }
  const resolved: Record<string, unknown> = {};
  for (const [id, schema] of schemas) {
    const parsed = schema.safeParse(raw[id] ?? {});
    if (!parsed.success) {
      const where = sources.get(id) ?? "defaults";
      throw new Error(
        `invalid config for plugin '${id}' (in ${where}): ${formatIssue(parsed.error)}`,
      );
    }
    resolved[id] = parsed.data;
  }
  return resolved;
}

function mergeDocs(layers: Layer[]): SettingsDoc {
  return layers.reduce<SettingsDoc>((acc, layer) => deepMerge(acc, layer.doc) as SettingsDoc, {});
}

/** The most-recent (highest-precedence) layer that set each plugin's slice. */
function pluginSources(layers: Layer[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const layer of layers) {
    for (const id of Object.keys(layer.doc.plugins ?? {})) sources.set(id, layer.label);
  }
  return sources;
}

async function pushFileLayer(
  layers: Layer[],
  label: string,
  file: string,
  schema: ZodType<SettingsDoc>,
): Promise<void> {
  const doc = await readDoc(file, schema);
  if (doc) layers.push({ label: `${label} (${file})`, doc });
}

async function readDoc(
  file: string,
  schema: ZodType<SettingsDoc>,
): Promise<SettingsDoc | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`, { cause: error });
  }
  // Provider connections are machine-global; project layers parse as project docs.
  const document = decodeSettingsFile(raw, file);
  if (schema === settingsDocSchema) return parseSettingsDoc(document, file);
  return parseProjectDoc(document, file);
}

/** Walks up from `start`, returning the first dir where `match` holds, else `undefined`. */
async function walkUp(
  start: string,
  match: (dir: string) => Promise<boolean>,
  boundary?: string,
): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    if (boundary && samePath(dir, boundary)) return undefined;
    if (await match(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The conversation's project root. An existing project is marked by a `.harness/` dir — but never
 * the harness home itself (`~/.harness` is settings storage, not a project), so a project living
 * under the home with no `.harness/` of its own isn't mistaken for the home. A project still has a
 * root before its `.harness/` exists (the settings writer and output store `mkdir` it on demand):
 * the enclosing git repo, else the start dir. Always returns a dir when `start` is given.
 */
export async function findProjectRoot(start: string, home = defaultHome()): Promise<string> {
  // A development HARNESS_HOME override must not turn the account's ordinary
  // global settings into a project layer while walking an unrelated workspace.
  const requestedHomes = [resolve(home), resolve(defaultHome()), join(homedir(), ".harness")];
  const [resolvedStart, homes, parents] = await Promise.all([
    canonicalPath(start),
    Promise.all(requestedHomes.map(canonicalPath)),
    Promise.all(
      requestedHomes
        .filter((candidate) => samePath(join(dirname(candidate), ".harness"), candidate))
        .map((candidate) => canonicalPath(dirname(candidate))),
    ),
  ]);
  // Only `<parent>/.harness` makes its parent ambiguous with a project marker. An arbitrary
  // custom-named home inside a repository must not hide that repository from the upward walk.
  const boundary = parents
    .filter((candidate) => containsPath(candidate, resolvedStart))
    .sort((a, b) => b.length - a.length)[0];
  const marked = await walkUp(
    resolvedStart,
    async (d) => {
      const marker = join(d, ".harness");
      if (!(await isDirectory(marker))) return false;
      const physical = await canonicalPath(marker);
      return !homes.some((candidate) => samePath(physical, candidate));
    },
    boundary,
  );
  if (marked) return marked;
  return (
    (await walkUp(resolvedStart, async (d) => await exists(join(d, ".git")), boundary)) ??
    resolvedStart
  );
}

/**
 * Whether a resolved root IS the harness home (its `.harness/` is the home itself). The marked walk
 * already skips the home, but the git/start fallbacks can still climb to it — `~` directly, or a
 * project under a git-tracked `~` — so callers must treat such a root as projectless (read the global
 * layer only, never `~/.harness/settings.local.json` as project-local). Guards the leak at the point
 * where `<root>/.harness/*` is consumed, since that's the invariant: the home is settings storage,
 * not a project.
 */
export async function isHomeRoot(root: string, home = defaultHome()): Promise<boolean> {
  const [candidate, globals] = await Promise.all([
    canonicalPath(join(root, ".harness")),
    Promise.all([canonicalPath(home), canonicalPath(join(homedir(), ".harness"))]),
  ]);
  return globals.some((global) => samePath(candidate, global));
}

/** Short Windows names and junctions must not turn global settings into project settings. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Settings directories and new workspaces need not exist yet.
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonicalPath(parent), basename(absolute));
  }
}

function samePath(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === "";
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Check source ownership before merging away the source of a plugin contribution. */
export function validateGlobalPluginScopes(
  doc: SettingsDoc,
  ids: ReadonlySet<string>,
  source: string,
  global: boolean,
): void {
  for (const id of ids) {
    if (!global && doc.plugins?.[id] !== undefined)
      throw new Error(`plugin '${id}' is global-only (in ${source})`);
    for (const [name, profile] of Object.entries(doc.profiles ?? {})) {
      if (profile.plugins?.[id] !== undefined)
        throw new Error(`plugin '${id}' is global-only (in profile '${name}' of ${source})`);
    }
  }
}
