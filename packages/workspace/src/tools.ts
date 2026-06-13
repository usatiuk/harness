import { z } from "zod";
import { applyDiff } from "@openai/agents-core/utils";
import {
  errorResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { executionOf } from "@harness/execution";
import { APPLY_PATCH_LARK, parseEnvelope, type FileChange } from "./apply-patch-parse.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const MAX_HITS = 200;

function ok(text: string): ToolResult {
  return { forModel: [{ type: "text", text }], status: "ok" };
}

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

const readArgs = z.strictObject({ path: z.string() });
export class ReadFileTool implements Tool<z.infer<typeof readArgs>> {
  readonly name = "read_file";
  readonly description = "Read a UTF-8 text file. `path` is relative to the workspace root.";
  readonly input: ToolInput<z.infer<typeof readArgs>> = { kind: "function", schema: readArgs };
  async execute({ path }: z.infer<typeof readArgs>, ctx: ToolContext): Promise<ToolResult> {
    return ok(decoder.decode(await executionOf(ctx).read(path)));
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
    return ok(`wrote ${bytes.length} bytes to ${path}`);
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
    return ok(done.join("\n") || "no changes");
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
    return ok(`edited ${path}`);
  }
}

const bashArgs = z.strictObject({ command: z.string() });
export class BashTool implements Tool<z.infer<typeof bashArgs>> {
  readonly name = "bash";
  readonly description = "Run a shell command in the workspace root.";
  readonly input: ToolInput<z.infer<typeof bashArgs>> = { kind: "function", schema: bashArgs };
  async execute({ command }: z.infer<typeof bashArgs>, ctx: ToolContext): Promise<ToolResult> {
    const result = await executionOf(ctx).run(command, { signal: ctx.signal });
    const parts = [`exit ${result.exitCode}`];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    return {
      forModel: [{ type: "text", text: parts.join("\n\n") }],
      status: result.exitCode === 0 ? "ok" : "error",
    };
  }
}

const globArgs = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});
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
    const matches = await executionOf(ctx).list(path ? `${path}/${pattern}` : pattern);
    return ok(matches.length ? matches.join("\n") : "no matches");
  }
}

const grepArgs = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});
export class GrepTool implements Tool<z.infer<typeof grepArgs>> {
  readonly name = "grep";
  readonly description =
    "Search file contents by JS regex `pattern`, returning `file:line:text`. Optional " +
    '`path` scopes the search to a subdirectory (use "." for the whole workspace).';
  readonly input: ToolInput<z.infer<typeof grepArgs>> = { kind: "function", schema: grepArgs };
  async execute(
    { pattern, path }: z.infer<typeof grepArgs>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return errorResult(`invalid regex: ${(error as Error).message}`);
    }
    const exec = executionOf(ctx);
    const files = await exec.list(path ? `${path}/**/*` : "**/*");
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= MAX_HITS) break;
      let text: string;
      try {
        text = decoder.decode(await exec.read(file));
      } catch {
        continue; // directories and unreadable entries are skipped
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
        if (regex.test(lines[i]!)) hits.push(`${file}:${i + 1}:${lines[i]}`);
      }
    }
    return ok(hits.length ? hits.join("\n") : "no matches");
  }
}
