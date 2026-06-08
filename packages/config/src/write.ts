import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelConfig } from "@harness/protocol";
import { formatIssue, settingsDocSchema } from "./settings.ts";

/**
 * Sets the global default `model` in `<home>/settings.json`, preserving every other
 * key and profile. A missing file starts from `{}`. The merged document is validated
 * against `settingsDocSchema` before it is written, so a corrupt file fails loudly.
 */
export async function updateGlobalModel(home: string, model: ModelConfig): Promise<void> {
  const path = join(home, "settings.json");
  const existing = await readSettings(path);
  const merged = { ...existing, model };
  const parsed = settingsDocSchema.safeParse(merged);
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
