import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultHome } from "@harness/config";

/** Keep recall snappy and the file small; oldest entries fall off. */
const MAX_ENTRIES = 200;

/** Cross-session prompt history, stored next to the durable store. */
export const historyPath = (): string => join(defaultHome(), "history.jsonl");

/**
 * Reads submitted prompts oldest-first. Each line is a JSON-encoded string, so
 * embedded newlines/control characters survive a round trip. A missing or
 * partially corrupt file yields whatever parses rather than failing launch.
 */
export function loadHistory(path: string = historyPath()): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "string") out.push(value);
    } catch {
      // Skip a malformed line; keep the rest.
    }
  }
  return out;
}

/**
 * Returns `entries` with `line` as the newest, deduped move-to-front (a repeat
 * jumps to the end instead of duplicating) and capped to the most recent
 * MAX_ENTRIES. Blank lines are ignored.
 */
export function addEntry(entries: string[], line: string): string[] {
  if (line.trim() === "") return entries;
  const next = entries.filter((e) => e !== line);
  next.push(line);
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

/** Persists the whole history (small file; a full rewrite keeps dedup trivial). */
export function saveHistory(entries: string[], path: string = historyPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch {
    // History is best-effort; a write failure must never break input.
  }
}
