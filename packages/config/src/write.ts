import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelConfig } from "@harness/protocol";
import {
  AUTH_STORE_KINDS,
  formatIssue,
  settingsDocSchema,
  type AuthStoreKind,
} from "./settings.ts";

/**
 * Sets the global default `model`, preserving every other key and profile. A missing file starts
 * from `{}`.
 */
export async function updateGlobalModel(home: string, model: ModelConfig): Promise<void> {
  const path = globalPath(home);
  await writeSettings(path, { ...(await readSettings(path)), model });
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
  const parsed = settingsDocSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`invalid settings at ${path}: ${formatIssue(parsed.error)}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
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
