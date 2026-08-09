import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import type { ConversationConfig } from "@harness/protocol";
import { deepMerge } from "./merge.ts";
import { defaultHome } from "./home.ts";
import {
  formatIssue,
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
  if (root && !isHomeRoot(root, opts.home)) {
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
    const parsed = settingsDocSchema.safeParse(opts.overrides);
    if (!parsed.success) throw new Error(`invalid overrides: ${formatIssue(parsed.error)}`);
    layers.push({ label: "overrides", doc: parsed.data });
  }

  const doc = mergeDocs(layers);
  const sources = pluginSources(layers);

  if (!doc.model) {
    throw new Error("no model configured (set `model` in settings or pass it as an override)");
  }

  return {
    instructions: doc.instructions ?? "",
    model: {
      provider: doc.model.provider,
      model: doc.model.model,
      ...(doc.model.preset ? { preset: doc.model.preset } : {}),
    },
    ...(doc.tools?.allow ? { tools: { allow: doc.tools.allow } } : {}),
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
  if (root && !isHomeRoot(root, home)) {
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
  return layers.reduce<SettingsDoc>((acc, layer) => {
    const merged = deepMerge(acc, layer.doc) as SettingsDoc;
    // A preset is meaningful only for its exact provider/model. Every model layer is a complete
    // selection, so replace it atomically rather than inheriting a preset from a lower layer.
    if (layer.doc.model) merged.model = layer.doc.model;
    return merged;
  }, {});
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
  // The global layer can carry `customProviders`, so it parses as a settings
  // doc; project layers reject customProviders and parse as project docs.
  if (schema === settingsDocSchema) return parseSettingsDoc(raw, file);
  return parseProjectDoc(raw, file);
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
  const resolvedStart = resolve(start);
  const resolvedHome = resolve(home);
  const homes = [resolvedHome, resolve(defaultHome())];
  // Only `<parent>/.harness` makes its parent ambiguous with a project marker. An arbitrary
  // custom-named home inside a repository must not hide that repository from the upward walk.
  const boundary = homes
    .filter((candidate) => samePath(join(dirname(candidate), ".harness"), candidate))
    .map(dirname)
    .filter((candidate) => containsPath(candidate, resolvedStart))
    .sort((a, b) => b.length - a.length)[0];
  const marked = await walkUp(
    resolvedStart,
    async (d) =>
      (await isDirectory(join(d, ".harness"))) &&
      !homes.some((candidate) => samePath(join(d, ".harness"), candidate)),
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
export function isHomeRoot(root: string, home = defaultHome()): boolean {
  return samePath(join(root, ".harness"), home);
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
