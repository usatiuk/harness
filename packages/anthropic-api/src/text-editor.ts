import { z } from "zod";
import {
  contextWithExecution,
  executionControlShape,
  executionOf,
  registerExecutionTool,
  splitStructuredExecutionArgs,
  type ExecutionContext,
} from "@harness/execution";
import {
  errorResult,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from "@harness/protocol";
import { uniqueReplace } from "@harness/workspace";

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

// The flat input is what the model sees: Anthropic custom tools reject top-level JSON Schema
// unions. The pipeline's output retains exact command-specific validation for tool execution.
const editorInputShape = {
  command: z
    .enum(["view", "create", "str_replace", "insert"])
    .describe("Editor operation to perform."),
  path: z
    .string()
    .describe(
      "File or directory path. Prefer a workspace-relative path such as README.md for project files.",
    ),
  view_range: z
    .tuple([z.number().int(), z.number().int()])
    .optional()
    .describe("Optional [start, end] line range for view; use -1 for the final line."),
  file_text: z.string().optional().describe("Required file contents for create."),
  old_str: z.string().optional().describe("Required text to find for str_replace."),
  new_str: z
    .string()
    .optional()
    .describe("Replacement text for str_replace, or text to insert for insert."),
  insert_line: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("For insert, the line after which to insert; use 0 to insert at the beginning."),
};
const editorWireArgs = z.strictObject(editorInputShape);
const editorCommandArgs = z.discriminatedUnion("command", [
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
const editorArgs = editorWireArgs.pipe(editorCommandArgs);
const escalatableEditorCommandArgs = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("view"),
    path: z.string(),
    view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  }),
  z.strictObject({
    command: z.literal("create"),
    path: z.string(),
    file_text: z.string(),
    ...executionControlShape,
  }),
  z.strictObject({
    command: z.literal("str_replace"),
    path: z.string(),
    old_str: z.string(),
    new_str: z.string().optional().default(""),
    ...executionControlShape,
  }),
  z.strictObject({
    command: z.literal("insert"),
    path: z.string(),
    insert_line: z.number().int().nonnegative(),
    new_str: z.string(),
    ...executionControlShape,
  }),
]);
const escalatableEditorArgs = z
  .strictObject({ ...editorInputShape, ...executionControlShape })
  .pipe(escalatableEditorCommandArgs);

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
 * Harness's function-tool rendition of Claude's familiar text-editor contract. Harness owns the
 * schema and execution, which lets Native add its explicit escalation fields while retaining
 * `uniqueReplace` semantics shared with the workspace `edit` tool.
 */
export class TextEditorTool implements Tool<EditorArgs> {
  readonly name = "str_replace_based_edit_tool";
  readonly description =
    "View and edit files. Use workspace-relative paths for project files. Commands: view requires " +
    "path and optionally view_range; create requires path and file_text; str_replace requires " +
    "path and old_str and optionally new_str; insert requires path, insert_line, and new_str. " +
    "Only provide fields relevant to the selected command.";
  readonly input: ToolInput<EditorArgs> = {
    kind: "function",
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

/** Provider-shaped but Harness-executed editor, registered with the selected execution backend. */
export function executionTextEditorTool(execution: ExecutionContext): Tool {
  const tool = new TextEditorTool();
  registerExecutionTool(execution, tool.name);
  if (!execution.unconfined) return tool;
  return {
    name: tool.name,
    description: tool.description,
    input: { kind: "function", schema: escalatableEditorArgs },
    async execute(value, ctx) {
      const split = splitStructuredExecutionArgs(value);
      if (split.error) return split.error;
      const selected = split.escalation ? execution.unconfined! : execution;
      return tool.execute(split.args as EditorArgs, contextWithExecution(ctx, selected));
    },
  };
}
