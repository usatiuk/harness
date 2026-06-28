import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyDiff } from "@openai/agents-core/utils";
import {
  errorResult,
  okResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { boundView, executionOf } from "@harness/execution";
import { activitiesOf } from "@harness/activities";
import { createProcessActivity } from "./process-activity.ts";
import { APPLY_PATCH_LARK, parseEnvelope, type FileChange } from "./apply-patch-parse.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
// A generous safety bound on matches collected; large results are preserved to a file by the
// output-bounding middleware, so this only guards against pathological memory use.
const MAX_HITS = 1000;

/** Outcome of a unique string replacement: the new text, or why it couldn't be done. */
export type ReplaceResult =
  | { ok: true; text: string }
  | { ok: false; reason: "absent" | "ambiguous"; count: number };

/**
 * Replaces the single occurrence of `oldStr` with `newStr` in `current`, or reports why it
 * can't: `absent` (no match) or `ambiguous` (more than one). The one source of truth for the
 * "edit a unique span" semantics shared by `edit` and Claude's `text_editor` `str_replace`.
 */
export function uniqueReplace(current: string, oldStr: string, newStr: string): ReplaceResult {
  const count = current.split(oldStr).length - 1;
  if (count === 0) return { ok: false, reason: "absent", count };
  if (count > 1) return { ok: false, reason: "ambiguous", count };
  return { ok: true, text: current.replace(oldStr, newStr) };
}

const DEFAULT_READ_LINES = 2000;
const readArgs = z.strictObject({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export class ReadFileTool implements Tool<z.infer<typeof readArgs>> {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file. `path` is relative to the workspace root. Reads a window of lines " +
    "(`offset` 0-based, `limit` line count); large files are shown a window you can scroll with " +
    "`offset`/`limit`.";
  readonly input: ToolInput<z.infer<typeof readArgs>> = { kind: "function", schema: readArgs };
  // Output is itself a named file the model narrows via offset/limit; the bounding middleware skips it.
  readonly meta = { addressableOutput: true };
  async execute(
    { path, offset, limit }: z.infer<typeof readArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const lines = decoder.decode(await executionOf(ctx).read(path)).split("\n");
    const start = offset ?? 0;
    const count = limit ?? DEFAULT_READ_LINES;
    const end = Math.min(start + count, lines.length);
    const body = boundView(lines.slice(start, start + count).join("\n"), {
      maxLines: count,
      maxLineBytes: 2048,
      maxTotalBytes: 256 * 1024,
      mode: "head",
    });
    const windowed = start > 0 || end < lines.length;
    const header = windowed ? `[lines ${start + 1}-${end} of ${lines.length}]\n` : "";
    return okResult(header + body);
  }
}

const writeArgs = z.strictObject({ path: z.string(), content: z.string() });
export class WriteTool implements Tool<z.infer<typeof writeArgs>> {
  readonly name = "write";
  readonly description =
    "Write `content` to `path` (relative to the workspace), creating parent dirs.";
  readonly input: ToolInput<z.infer<typeof writeArgs>> = { kind: "function", schema: writeArgs };
  async execute(
    { path, content }: z.infer<typeof writeArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const bytes = encoder.encode(content);
    await executionOf(ctx).write(path, bytes);
    return okResult(`wrote ${bytes.length} bytes to ${path}`);
  }
}

/** Freeform V4A patch editor; the kernel parses the envelope, so `execute` gets `FileChange[]`. */
export class ApplyPatchTool implements Tool<FileChange[]> {
  readonly name = "apply_patch";
  readonly description =
    "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap " +
    "the patch in JSON.";
  readonly input: ToolInput<FileChange[]> = {
    kind: "custom",
    grammar: { syntax: "lark", definition: APPLY_PATCH_LARK },
    parse: parseEnvelope,
  };
  async execute(changes: FileChange[], ctx: ToolContext): Promise<ToolResult> {
    const exec = executionOf(ctx);
    const done: string[] = [];
    for (const change of changes) {
      try {
        switch (change.type) {
          case "create_file":
            await exec.write(change.path, encoder.encode(applyDiff("", change.diff, "create")));
            done.push(`created ${change.path}`);
            break;
          case "update_file": {
            const current = decoder.decode(await exec.read(change.path));
            const updated = encoder.encode(applyDiff(current, change.diff));
            await exec.write(change.newPath ?? change.path, updated);
            if (change.newPath) await exec.remove(change.path);
            done.push(
              change.newPath
                ? `updated ${change.path} -> ${change.newPath}`
                : `updated ${change.path}`,
            );
            break;
          }
          case "delete_file":
            await exec.remove(change.path);
            done.push(`deleted ${change.path}`);
            break;
        }
      } catch (error) {
        return errorResult(`apply_patch failed on ${change.path}: ${(error as Error).message}`);
      }
    }
    return okResult(done.join("\n") || "no changes");
  }
}

const editArgs = z.strictObject({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});
export class EditTool implements Tool<z.infer<typeof editArgs>> {
  readonly name = "edit";
  readonly description =
    "Replace the single occurrence of `old_string` with `new_string` in `path` (relative " +
    "to the workspace). Errors if `old_string` is absent or not unique; use `write` to " +
    "create files.";
  readonly input: ToolInput<z.infer<typeof editArgs>> = { kind: "function", schema: editArgs };
  async execute(
    { path, old_string, new_string }: z.infer<typeof editArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const exec = executionOf(ctx);
    let current: string;
    try {
      current = decoder.decode(await exec.read(path));
    } catch (error) {
      return errorResult(`edit failed: cannot read ${path}: ${(error as Error).message}`);
    }
    const result = uniqueReplace(current, old_string, new_string);
    if (!result.ok) {
      return errorResult(
        result.reason === "absent"
          ? `edit failed: old_string not found in ${path}`
          : `edit failed: old_string is not unique in ${path} (${result.count} matches)`,
      );
    }
    await exec.write(path, encoder.encode(result.text));
    return okResult(`edited ${path}`);
  }
}

const bashArgs = z.strictObject({ command: z.string() });
export class BashTool implements Tool<z.infer<typeof bashArgs>> {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the workspace root. Quick commands return their output inline; " +
    "long-running ones (dev servers, watchers, builds) become activities you can wait on, peek " +
    "at, or kill.";
  readonly input: ToolInput<z.infer<typeof bashArgs>> = { kind: "function", schema: bashArgs };
  // The activities plugin reads this to inject the `background` argument into the wire schema.
  readonly meta = { backgroundable: true };
  execute({ command }: z.infer<typeof bashArgs>, ctx: ToolContext): Promise<ToolResult> {
    const exec = executionOf(ctx);
    const id = `act_${randomUUID().slice(0, 8)}`;
    // Spawn unbound from `ctx.signal`; backgrounded commands survive turn-end.
    const activity = createProcessActivity({
      id,
      title: command,
      proc: exec.spawn(command),
      store: exec.outputStore(ctx.conversationId),
    });
    activitiesOf(ctx).track(activity, { callId: ctx.callId, emit: (e) => ctx.emit(e) });
    // Placeholder; the consumption middleware owns the real model-facing result.
    return Promise.resolve({
      forModel: [{ type: "text", text: `started activity ${id}` }],
      status: "ok",
    });
  }
}

const globArgs = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});

/**
 * Builds the effective glob string from `pattern` + optional `path`. `list` matches against
 * workspace-relative paths with no `./` prefix (minimatch, which treats a leading `./` as literal and
 * matches nothing), so both inputs are normalized to that convention: strip a leading `./` and any
 * trailing `/`, and treat ""/"."/undefined `path` as the whole workspace. A bare directory scope
 * becomes `dir/pattern`. This is the documented "." contract made robust — `"./src"`, `"src/"`, and
 * `""` all behave like `"src"` / whole-workspace instead of silently matching nothing.
 */
export function scopedPattern(pattern: string, path?: string): string {
  const clean = (s: string): string => s.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const dir = path === undefined ? "" : clean(path);
  const pat = pattern.replace(/^\.\/+/, "");
  return dir === "" || dir === "." ? pat : `${dir}/${pat}`;
}
export class GlobTool implements Tool<z.infer<typeof globArgs>> {
  readonly name = "glob";
  readonly description =
    "List files matching a glob `pattern`. Optional `path` scopes the search to a " +
    'subdirectory (use "." for the whole workspace).';
  readonly input: ToolInput<z.infer<typeof globArgs>> = { kind: "function", schema: globArgs };
  async execute(
    { pattern, path }: z.infer<typeof globArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const matches = await executionOf(ctx).list(scopedPattern(pattern, path));
    return okResult(matches.length ? matches.join("\n") : "no matches");
  }
}

/** Single-quote a value for a POSIX shell, so a model-supplied pattern/path can't break out. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Bound on collected grep output; beyond it the search is killed and the result marked truncated.
const MAX_GREP_BYTES = 2 * 1024 * 1024;

const grepArgs = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});
export class GrepTool implements Tool<z.infer<typeof grepArgs>> {
  readonly name = "grep";
  readonly description =
    "Search file contents by POSIX extended-regex `pattern` (`grep -E`), returning " +
    '`file:line:text`. Optional `path` scopes the search to a subdirectory (use "." for the ' +
    "whole workspace). The whole-workspace search skips `.git` and `.harness`; pass one as `path` " +
    "to search inside it.";
  readonly input: ToolInput<z.infer<typeof grepArgs>> = { kind: "function", schema: grepArgs };
  async execute(
    { pattern, path }: z.infer<typeof grepArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const exec = executionOf(ctx);
    // A specific `path` is a deliberate scope, so search it verbatim. Only the broad whole-workspace
    // search skips the noise dirs (VCS metadata, the agent's own `.harness` output store) — so the
    // agent can still grep inside them by naming them (`path: ".git"`), which `--exclude-dir` would
    // otherwise silently prune even when targeted. Excludes are by name: a `.*` glob isn't portable
    // here, as BSD grep then prunes the search root `.` itself.
    const scoped = path !== undefined && path !== ".";
    const target = scoped ? path : ".";
    const excludes = scoped ? "" : "--exclude-dir=.git --exclude-dir=.harness ";
    // One recursive grep in the substrate (host or container) instead of read-every-file: `-r`
    // recurse, `-n` line numbers, `-I` skip binaries, `-E` ERE.
    const command = `grep -rnIE ${excludes}-- ${shellQuote(pattern)} ${shellQuote(target)}`;
    const proc = exec.spawn(command);
    let out = "";
    let truncated = false;
    proc.onData((chunk) => {
      if (truncated) return;
      out += chunk;
      if (out.length > MAX_GREP_BYTES) {
        truncated = true;
        proc.kill();
      }
    });
    const { code } = await proc.exit;
    // grep exits 1 for "no matches" (not an error) and ≥2 for a real failure (e.g. a bad regex);
    // a kill for truncation lands as a null code, which we treat as a successful capped result.
    if (!truncated && code !== null && code >= 2) {
      return errorResult(`grep failed: ${out.trim() || `exit ${code}`}`);
    }
    const hits = out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\.\//, ""));
    if (hits.length === 0) return okResult("no matches");
    const capped = truncated || hits.length > MAX_HITS;
    const shown = hits.slice(0, MAX_HITS);
    const header = `${shown.length}${capped ? "+" : ""} match(es):\n`;
    const footer = capped ? `\n…[stopped at ${shown.length} matches; refine your pattern]` : "";
    return okResult(header + shown.join("\n") + footer);
  }
}
