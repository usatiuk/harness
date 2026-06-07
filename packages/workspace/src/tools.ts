import { z } from "zod";
import { errorResult, type Tool, type ToolContext, type ToolResult } from "@harness/protocol";
import { executionOf } from "@harness/execution";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const MAX_HITS = 200;

/** JSON Schema for the model, derived from the zod arg schema. */
function parameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
/** Parses tool args, returning the typed value or a ready-to-return error result. */
function parseArgs<T>(schema: z.ZodType<T>, raw: unknown): { data: T } | ToolResult {
  const result = schema.safeParse(raw);
  if (result.success) return { data: result.data };
  return errorResult(`invalid args: ${result.error.issues[0]?.message ?? "invalid arguments"}`);
}
function ok(text: string): ToolResult {
  return { forModel: [{ type: "text", text }], status: "ok" };
}

const readArgs = z.strictObject({ path: z.string() });
export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly schema = {
    name: this.name,
    description: "Read a UTF-8 text file. `path` is relative to the workspace root.",
    parameters: parameters(readArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(readArgs, rawArgs);
    if ("forModel" in args) return args;
    return ok(decoder.decode(await executionOf(ctx).read(args.data.path)));
  }
}

const writeArgs = z.strictObject({ path: z.string(), content: z.string() });
export class WriteTool implements Tool {
  readonly name = "write";
  readonly schema = {
    name: this.name,
    description: "Write `content` to `path` (relative to the workspace), creating parent dirs.",
    parameters: parameters(writeArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(writeArgs, rawArgs);
    if ("forModel" in args) return args;
    const bytes = encoder.encode(args.data.content);
    await executionOf(ctx).write(args.data.path, bytes);
    return ok(`wrote ${bytes.length} bytes to ${args.data.path}`);
  }
}

const editArgs = z.strictObject({
  path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
});
export class EditTool implements Tool {
  readonly name = "edit";
  readonly schema = {
    name: this.name,
    description:
      "Replace the unique occurrence of `old_string` with `new_string` in `path`. " +
      "Fails if `old_string` is missing or appears more than once.",
    parameters: parameters(editArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(editArgs, rawArgs);
    if ("forModel" in args) return args;
    const { path, old_string, new_string } = args.data;
    const exec = executionOf(ctx);
    const text = decoder.decode(await exec.read(path));
    const matches = text.split(old_string).length - 1;
    if (matches === 0) return errorResult(`old_string not found in ${path}`);
    if (matches > 1) {
      return errorResult(`old_string is not unique in ${path} (${matches} matches); add context`);
    }
    await exec.write(path, encoder.encode(text.replace(old_string, new_string)));
    return ok(`edited ${path}`);
  }
}

const bashArgs = z.strictObject({ command: z.string() });
export class BashTool implements Tool {
  readonly name = "bash";
  readonly schema = {
    name: this.name,
    description: "Run a shell command in the workspace root.",
    parameters: parameters(bashArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(bashArgs, rawArgs);
    if ("forModel" in args) return args;
    const result = await executionOf(ctx).run(args.data.command, { signal: ctx.signal });
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
export class GlobTool implements Tool {
  readonly name = "glob";
  readonly schema = {
    name: this.name,
    description:
      "List files matching a glob `pattern`. Optional `path` scopes the search to a " +
      'subdirectory (use "." for the whole workspace).',
    parameters: parameters(globArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(globArgs, rawArgs);
    if ("forModel" in args) return args;
    const pattern = args.data.path ? `${args.data.path}/${args.data.pattern}` : args.data.pattern;
    const matches = await executionOf(ctx).list(pattern);
    return ok(matches.length ? matches.join("\n") : "no matches");
  }
}

const grepArgs = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});
export class GrepTool implements Tool {
  readonly name = "grep";
  readonly schema = {
    name: this.name,
    description:
      "Search file contents by JS regex `pattern`, returning `file:line:text`. Optional " +
      '`path` scopes the search to a subdirectory (use "." for the whole workspace).',
    parameters: parameters(grepArgs),
  };
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(grepArgs, rawArgs);
    if ("forModel" in args) return args;
    let regex: RegExp;
    try {
      regex = new RegExp(args.data.pattern);
    } catch (error) {
      return errorResult(`invalid regex: ${(error as Error).message}`);
    }
    const exec = executionOf(ctx);
    const files = await exec.list(args.data.path ? `${args.data.path}/**/*` : "**/*");
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
