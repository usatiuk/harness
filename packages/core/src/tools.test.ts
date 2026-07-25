import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Tool } from "@harness/protocol";
import { parseToolArgs, toToolSchema } from "./tools.ts";

const fnTool: Tool<{ path: string }> = {
  name: "read",
  description: "read a file",
  input: { kind: "function", schema: z.strictObject({ path: z.string() }) },
  execute: () => Promise.resolve({ forModel: [], status: "ok" }),
};

// A custom tool whose `parse` splits on commas; throws on an empty string.
const customTool: Tool<string[]> = {
  name: "list",
  description: "comma list",
  input: {
    kind: "custom",
    grammar: { syntax: "lark", definition: "GRAMMAR" },
    parse: (raw) => {
      if (raw === "") throw new Error("empty");
      return raw.split(",");
    },
  },
  execute: () => Promise.resolve({ forModel: [], status: "ok" }),
};

describe("toToolSchema", () => {
  it("derives a function schema's JSON Schema parameters, sans $schema", () => {
    const schema = toToolSchema(fnTool);
    expect(schema.kind).toBe("function");
    if (schema.kind !== "function") throw new Error("expected function");
    expect(schema).toMatchObject({ name: "read", description: "read a file" });
    expect(schema.parameters).not.toHaveProperty("$schema");
    expect(schema.parameters.type).toBe("object");
  });

  it("describes a parser pipeline's model input rather than its validated output", () => {
    const input = z.strictObject({
      command: z.enum(["view", "create"]),
      path: z.string(),
      file_text: z.string().optional(),
    });
    const output = z.discriminatedUnion("command", [
      z.strictObject({ command: z.literal("view"), path: z.string() }),
      z.strictObject({
        command: z.literal("create"),
        path: z.string(),
        file_text: z.string(),
      }),
    ]);
    const tool: Tool<z.infer<typeof output>> = {
      name: "editor",
      description: "edit",
      input: { kind: "function", schema: input.pipe(output) },
      execute: () => Promise.resolve({ forModel: [], status: "ok" }),
    };

    const schema = toToolSchema(tool);
    expect(schema.kind).toBe("function");
    if (schema.kind !== "function") throw new Error("expected function");
    expect(schema.parameters).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string", enum: ["view", "create"] },
        path: { type: "string" },
        file_text: { type: "string" },
      },
      required: ["command", "path"],
    });
    expect(schema.parameters).not.toHaveProperty("oneOf");
  });

  it("derives a custom schema carrying its grammar", () => {
    expect(toToolSchema(customTool)).toEqual({
      kind: "custom",
      name: "list",
      description: "comma list",
      grammar: { syntax: "lark", definition: "GRAMMAR" },
    });
  });
});

describe("parseToolArgs", () => {
  it("validates function args via the zod schema", () => {
    expect(parseToolArgs(fnTool, { path: "a.txt" })).toEqual({ ok: true, data: { path: "a.txt" } });
  });

  it("returns an error result for invalid function args", () => {
    const parsed = parseToolArgs(fnTool, { path: 1 });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.result.status).toBe("error");
  });

  it("parses a custom tool's raw string via its parser", () => {
    expect(parseToolArgs(customTool, "a,b,c")).toEqual({ ok: true, data: ["a", "b", "c"] });
  });

  it("errors when a custom tool receives a non-string", () => {
    const parsed = parseToolArgs(customTool, { not: "a string" });
    expect(parsed.ok === false && parsed.result.status).toBe("error");
  });

  it("surfaces a custom parser's throw as an error result", () => {
    const parsed = parseToolArgs(customTool, "");
    expect(parsed.ok === false && parsed.result.forModel[0]).toMatchObject({ text: "empty" });
  });
});
