import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ZodType } from "zod";
import type { ConversationConfig } from "@harness/protocol";
import { deepMerge } from "./merge.ts";
import { formatIssue, settingsDocSchema, type SettingsDoc } from "./settings.ts";

export interface ResolveOptions {
  /** Harness home directory; the global layer is `<home>/settings.json`. */
  home: string;
  /** Where the project search starts. Absent ⇒ projectless (project layers skipped). */
  cwd?: string;
  /** Named profile to overlay above the project layers. */
  profile?: string;
  /** Programmatic top layer (highest precedence), e.g. CLI-chosen model. */
  overrides?: SettingsDoc;
  /** Plugin id → config schema, for central validation of plugin slices. */
  schemas: Map<string, ZodType>;
}

/** One labelled layer in the cascade; the label cites the source in errors. */
interface Layer {
  label: string;
  doc: SettingsDoc;
}

/**
 * Collapses the settings cascade into a frozen `ConversationConfig` snapshot:
 * `global < project-shared < project-local < profile < overrides`. Validates the
 * kernel doc per file and each plugin slice against its schema; unknown plugins and
 * unknown keys fail fast, citing the source file.
 */
export async function resolveSettings(opts: ResolveOptions): Promise<ConversationConfig> {
  const root = opts.cwd ? await findProjectRoot(opts.cwd) : undefined;

  const layers: Layer[] = [];
  await pushFileLayer(layers, "global settings", join(opts.home, "settings.json"));
  if (root) {
    await pushFileLayer(layers, "project settings", join(root, ".harness", "settings.json"));
    await pushFileLayer(layers, "local settings", join(root, ".harness", "settings.local.json"));
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
    model: doc.model,
    workspaceRoot: root ?? opts.cwd ?? null,
    ...(doc.tools?.allow ? { tools: { allow: doc.tools.allow } } : {}),
    plugins: resolvePlugins(doc.plugins ?? {}, opts.schemas, sources),
  };
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

async function pushFileLayer(layers: Layer[], label: string, file: string): Promise<void> {
  const doc = await readDoc(file);
  if (doc) layers.push({ label: `${label} (${file})`, doc });
}

async function readDoc(file: string): Promise<SettingsDoc | undefined> {
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
  const parsed = settingsDocSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid settings in ${file}: ${formatIssue(parsed.error)}`);
  return parsed.data;
}

/** Walks up from `start` to the first ancestor containing a `.harness/` directory. */
async function findProjectRoot(start: string): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    if (await isDirectory(join(dir, ".harness"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
