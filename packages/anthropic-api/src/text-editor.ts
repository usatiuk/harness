import { z } from "zod";
import {
  errorResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { executionOf, type ExecutionContext } from "@harness/execution";
import { uniqueReplace } from "@harness/workspace";
import { TEXT_EDITOR_ID } from "@harness/anthropic-core";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ok = (text: string): ToolResult => ({ forModel: [{ type: "text", text }], status: "ok" });

/** Cap on entries returned by a directory `view`, so a large tree can't flood the context. */
const MAX_DIR_ENTRIES = 200;

/**
 * Lists a directory's non-hidden entries up to two levels deep — Anthropic's text_editor `view`
 * behavior. Caller has already confirmed `path` is a directory via `stat`. (`dot:false` glob
 * default excludes hidden entries.)
 */
async function listDirectory(exec: ExecutionContext, path: string): Promise<string> {
  const prefix = path === "" || path === "." ? "" : `${path.replace(/\/+$/, "")}/`;
  const [shallow, deep] = await Promise.all([exec.list(`${prefix}*`), exec.list(`${prefix}*/*`)]);
  const sorted = [...new Set([...shallow, ...deep])].sort();
  if (sorted.length === 0) return "(empty directory)";
  const shown = sorted.slice(0, MAX_DIR_ENTRIES);
  const more = sorted.length - shown.length;
  return more > 0 ? `${shown.join("\n")}\n… ${more} more (truncated)` : shown.join("\n");
}

// Wire schema is owned by Anthropic (the model is trained on it); this zod union only
// defensively validates the model's structured input before `execute` runs.
const editorArgs = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("view"),
    path: z.string(),
    view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  }),
  z.object({ command: z.literal("create"), path: z.string(), file_text: z.string() }),
  z.object({
    command: z.literal("str_replace"),
    path: z.string(),
    old_str: z.string(),
    new_str: z.string().optional().default(""),
  }),
  z.object({
    command: z.literal("insert"),
    path: z.string(),
    insert_line: z.number().int().nonnegative(),
    new_str: z.string(),
  }),
]);

type EditorArgs = z.infer<typeof editorArgs>;

/** Renders file content `cat -n`-style; the model is trained to read `view` output line-numbered. */
function numbered(text: string, range?: [number, number]): string {
  const lines = text.split("\n");
  const start = range ? Math.max(1, range[0]) : 1;
  const end = range ? (range[1] === -1 ? lines.length : range[1]) : lines.length;
  const out: string[] = [];
  for (let i = start; i <= Math.min(end, lines.length); i++) {
    out.push(`${String(i).padStart(6)}\t${lines[i - 1]}`);
  }
  return out.join("\n");
}

/**
 * Claude's native file editor (`text_editor_20250728`). Declared via the `native` tool arm so the
 * provider renders the built-in from its id; this class supplies execution, reusing `uniqueReplace`
 * for the single-occurrence `str_replace` semantics it shares with the workspace `edit` tool.
 */
export class TextEditorTool implements Tool<EditorArgs> {
  readonly name = "str_replace_based_edit_tool";
  readonly description = "Claude's native file editor: view, create, str_replace, and insert.";
  readonly input: ToolInput<EditorArgs> = {
    kind: "native",
    id: TEXT_EDITOR_ID,
    schema: editorArgs,
  };

  async execute(args: EditorArgs, ctx: ToolContext): Promise<ToolResult> {
    const exec = executionOf(ctx);
    const read = async (): Promise<string> => decoder.decode(await exec.read(args.path));

    switch (args.command) {
      case "view": {
        // A directory lists its entries; a file shows its (optionally ranged) contents.
        if ((await exec.stat(args.path))?.isDirectory)
          return ok(await listDirectory(exec, args.path));
        try {
          return ok(numbered(await read(), args.view_range));
        } catch (error) {
          return errorResult(`view failed: cannot read ${args.path}: ${(error as Error).message}`);
        }
      }
      case "create": {
        await exec.write(args.path, encoder.encode(args.file_text));
        return ok(`created ${args.path}`);
      }
      case "str_replace": {
        let current: string;
        try {
          current = await read();
        } catch (error) {
          return errorResult(
            `str_replace failed: cannot read ${args.path}: ${(error as Error).message}`,
          );
        }
        const result = uniqueReplace(current, args.old_str, args.new_str);
        if (!result.ok) {
          return errorResult(
            result.reason === "absent"
              ? `str_replace failed: old_str not found in ${args.path}`
              : `str_replace failed: old_str is not unique in ${args.path} (${result.count} matches)`,
          );
        }
        await exec.write(args.path, encoder.encode(result.text));
        return ok(`edited ${args.path}`);
      }
      case "insert": {
        let lines: string[];
        try {
          lines = (await read()).split("\n");
        } catch (error) {
          return errorResult(
            `insert failed: cannot read ${args.path}: ${(error as Error).message}`,
          );
        }
        if (args.insert_line > lines.length) {
          return errorResult(
            `insert failed: insert_line ${args.insert_line} is past end of ${args.path} (${lines.length} lines)`,
          );
        }
        lines.splice(args.insert_line, 0, ...args.new_str.split("\n"));
        await exec.write(args.path, encoder.encode(lines.join("\n")));
        return ok(`inserted into ${args.path} after line ${args.insert_line}`);
      }
    }
  }
}
