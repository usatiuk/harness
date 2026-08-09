import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelConfig } from "@harness/protocol";
import { defaultHome } from "./home.ts";
import { findProjectRoot, isHomeRoot } from "./resolve.ts";
import {
  AUTH_STORE_KINDS,
  parseProjectDoc,
  parseSettingsDoc,
  type AuthStoreKind,
  type SettingsDoc,
} from "./settings.ts";
import { deepMerge } from "./merge.ts";

/**
 * Sets the global default `model`, preserving every other key and profile. A missing file starts
 * from `{}`.
 */
export async function updateGlobalModel(home: string, model: ModelConfig): Promise<void> {
  const path = globalPath(home);
  await writeSettings(path, { ...(await readSettings(path)), model });
}

/** Deep-patches one global plugin slice without replacing sibling plugins or slice fields. */
export async function updateGlobalPluginConfig(
  home: string,
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const path = globalPath(home);
  const existing = await readSettings(path);
  const plugins = (existing.plugins as Record<string, unknown> | undefined) ?? {};
  const current = plugins[pluginId] ?? {};
  await writeSettings(path, {
    ...existing,
    plugins: { ...plugins, [pluginId]: deepMerge(current, patch) },
  });
}

/** Records which credential backend this machine uses; read back by `getAuthStore`. */
export async function setAuthStore(home: string, store: AuthStoreKind): Promise<void> {
  const path = globalPath(home);
  const existing = await readSettings(path);
  const auth = (existing.auth as Record<string, unknown> | undefined) ?? {};
  await writeSettings(path, { ...existing, auth: { ...auth, store } });
}

/** The persisted credential backend, or undefined when no `auth login` has chosen one yet. */
export async function getAuthStore(home: string): Promise<AuthStoreKind | undefined> {
  const existing = await readSettings(globalPath(home));
  const store = (existing.auth as { store?: unknown } | undefined)?.store;
  // Validate rather than trust the cast: a malformed value reads as "no backend chosen" instead
  // of silently selecting the file store.
  return AUTH_STORE_KINDS.find((k) => k === store);
}

const globalPath = (home: string): string => join(home, "settings.json");

/** Validates the merged document against the schema (failing loudly), then writes it. */
async function writeSettings(path: string, doc: Record<string, unknown>): Promise<void> {
  const data = parseSettingsDoc(doc, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Applies `mutate` to the project's `.harness/settings.local.json`, validating before writing and
 * returning the path. The project root is `findProjectRoot(cwd)` (nearest `.harness/` ancestor,
 * never the home; else the git root; else `cwd`), and `.harness/` is created here on first write.
 * When the root resolves to the home itself (run from `~`, or a projectless dir under a git-tracked
 * `~`), there's no project to write into — and the read side ignores `~/.harness/settings.local.json`
 * — so the change persists to the global `settings.json`, the only layer that then applies.
 */
export async function updateLocalSettings(
  cwd: string,
  mutate: (doc: SettingsDoc) => SettingsDoc,
  home = defaultHome(),
): Promise<string> {
  const root = await findProjectRoot(cwd, home);
  const isGlobal = isHomeRoot(root, home);
  const path = isGlobal ? globalPath(home) : join(root, ".harness", "settings.local.json");
  const existing = (await readSettings(path)) as SettingsDoc;
  const merged = mutate(existing);
  const data = isGlobal ? parseSettingsDoc(merged, path) : parseProjectDoc(merged, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The validated global settings doc, or `{}` when no global settings file exists. */
export async function readGlobalSettings(home: string): Promise<SettingsDoc> {
  const raw = await readSettings(globalPath(home));
  return parseSettingsDoc(raw, globalPath(home));
}
