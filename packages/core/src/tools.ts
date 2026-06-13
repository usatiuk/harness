import { z } from "zod";
import { errorResult, type Tool, type ToolResult, type ToolSchema } from "@harness/protocol";

/** The wire schema a provider renders for a tool, derived from its `input`. */
export function toToolSchema(tool: Tool): ToolSchema {
  if (tool.input.kind === "function") {
    const parameters = z.toJSONSchema(tool.input.schema) as Record<string, unknown>;
    delete parameters.$schema;
    return { kind: "function", name: tool.name, description: tool.description, parameters };
  }
  if (tool.input.kind === "native") {
    // No JSON Schema: the provider renders the built-in from `id` onto its wire type.
    return { kind: "native", name: tool.name, description: tool.description, id: tool.input.id };
  }
  return {
    kind: "custom",
    name: tool.name,
    description: tool.description,
    ...(tool.input.grammar ? { grammar: tool.input.grammar } : {}),
  };
}

/** Validates raw call args against the tool's `input`; `execute` only ever runs on `ok` data. */
export function parseToolArgs(
  tool: Tool,
  rawArgs: unknown,
): { ok: true; data: unknown } | { ok: false; result: ToolResult } {
  // `function` and `native` both carry a zod schema over the model's structured object.
  if (tool.input.kind === "function" || tool.input.kind === "native") {
    const result = tool.input.schema.safeParse(rawArgs);
    if (result.success) return { ok: true, data: result.data };
    const message = result.error.issues[0]?.message ?? "invalid arguments";
    return { ok: false, result: errorResult(`invalid args: ${message}`) };
  }
  if (typeof rawArgs !== "string") {
    return { ok: false, result: errorResult(`${tool.name} expects raw text input`) };
  }
  try {
    return { ok: true, data: tool.input.parse(rawArgs) };
  } catch (error) {
    return { ok: false, result: errorResult((error as Error).message) };
  }
}
