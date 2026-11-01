import { escape, minimatch } from "minimatch";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** Combine a literal directory scope with a caller-supplied glob pattern. */
export function scopedPattern(pattern: string, path?: string): string {
  const dir = (path ?? "").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const pat = pattern.replace(/^\.\/+/, "");
  if (dir === "" || dir === ".") return pat;
  // Escape braces as well as wildcard syntax; leading !/# otherwise negate/comment the pattern.
  const literal = escape(dir, { magicalBraces: true }).replace(/^[!#]/, "\\$&");
  return `${literal}/${pat}`;
}

/** Outcome of resolving a tool `path` scope against the workspace root. */
export type ScopeResolution = { ok: true; dir: string } | { ok: false; error: string };

/**
 * Resolve a directory scope into the workspace-relative POSIX form consumed by `list`.
 * Absolute paths inside the workspace map to their relative form; outside scopes error.
 * Containment is lexical. Backslashes are separators on Windows hosts; a drive-letter absolute
 * path on a non-Windows host is an error.
 */
export function resolveScope(root: string | null, path: string): ScopeResolution {
  const base = root ?? process.cwd();
  if (/^[A-Za-z]:[\\/]/.test(path) && sep !== "\\") {
    return {
      ok: false,
      error: `path '${path}' is a Windows path, but workspace '${base}' is not on a Windows drive`,
    };
  }
  const rel = relative(base, resolve(base, path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `path '${path}' resolves outside the workspace '${base}'` };
  }
  return { ok: true, dir: rel.split(sep).join("/") };
}
