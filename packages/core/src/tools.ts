import { z } from "zod";
import {
  errorResult,
  type Tool,
  type ToolResult,
  type ToolSchema,
  type ModelCapabilities,
} from "@harness/protocol";

/** The wire schema a provider renders for a tool, derived from its `input`. */
export function toToolSchema(tool: Tool, caps?: ModelCapabilities): ToolSchema {
  if (tool.input.kind === "json-schema") {
    return {
      kind: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input.schema,
    };
  }
  if (tool.input.kind === "function") {
    // The model supplies the parser's input. For pipelines/defaults/transforms, the output schema
    // describes the already-parsed value and can differ from the wire contract.
    const parameters = z.toJSONSchema(tool.input.schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    delete parameters.$schema;
    return { kind: "function", name: tool.name, description: tool.description, parameters };
  }
  if (caps && !caps.customToolInput.supported) {
    const field = tool.input.jsonField;
    return {
      kind: "function",
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: { [field]: { type: "string" } },
        required: [field],
        additionalProperties: false,
      },
    };
  }
  const grammar = tool.input.grammar;
  return {
    kind: "custom",
    name: tool.name,
    description: tool.description,
    ...(grammar && (!caps || caps.customToolInput.grammars.includes(grammar.syntax))
      ? { grammar }
      : {}),
  };
}

/** Validates raw call args against the tool's `input`; `execute` only ever runs on `ok` data. */
export function parseToolArgs(
  tool: Tool,
  rawArgs: unknown,
): { ok: true; data: unknown } | { ok: false; result: ToolResult } {
  if (tool.input.kind === "function") {
    const result = tool.input.schema.safeParse(rawArgs);
    if (result.success) return { ok: true, data: result.data };
    const message = result.error.issues[0]?.message ?? "invalid arguments";
    return { ok: false, result: errorResult(`invalid args: ${message}`) };
  }
  if (tool.input.kind === "json-schema") {
    try {
      return { ok: true, data: tool.input.parse(rawArgs) };
    } catch {
      return {
        ok: false,
        result: errorResult("invalid args: advertised JSON Schema validation failed"),
      };
    }
  }
  const text = customToolText(tool, rawArgs);
  if (text === undefined) {
    return {
      ok: false,
      result: errorResult(`${tool.name} expects text or a ${tool.input.jsonField} string field`),
    };
  }
  try {
    return { ok: true, data: tool.input.parse(text) };
  } catch (error) {
    return { ok: false, result: errorResult((error as Error).message) };
  }
}

/** Both supported wire encodings share one parser and middleware-visible text value. */
export function customToolText(tool: Tool, args: unknown): string | undefined {
  if (tool.input.kind !== "custom") return undefined;
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const field = tool.input.jsonField;
  return Object.keys(record).length === 1 && typeof record[field] === "string"
    ? record[field]
    : undefined;
}
