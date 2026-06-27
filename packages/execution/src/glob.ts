import { minimatch } from "minimatch";

/**
 * Glob semantics for the workspace `list` substrate — the single matcher every backend filters
 * through, so the local (host `readdir`) and docker (container `find`) contexts match files
 * identically. Backends only enumerate their own filesystem; matching lives here. Mirrors
 * node-glob's defaults: `dot: false`, so a leading-dot path segment is excluded unless the pattern
 * names the dot explicitly.
 */
const OPTS = { dot: false } as const;

/** Workspace-relative paths matching `pattern`, sorted. The one source of glob truth across backends. */
export function matchGlob(paths: string[], pattern: string): string[] {
  return paths.filter((p) => minimatch(p, pattern, OPTS)).sort();
}

/**
 * Whether a directory could still contain a match, so a host-side walk can prune subtrees that no
 * path under them could match (the same pruning node-glob does). Uses minimatch partial matching, so
 * it stays consistent with `matchGlob`'s semantics.
 */
export function mayDescend(dir: string, pattern: string): boolean {
  return minimatch(dir, pattern, { ...OPTS, partial: true });
}
