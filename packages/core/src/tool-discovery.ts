import { z } from "zod";
import {
  jsonValueSchema,
  type Item,
  type Tool,
  type ToolContract,
  type ToolResult,
} from "@harness/protocol";
import { ToolSet } from "./registry.ts";

export const SEARCH_NAME = "tool_search";
export const DESCRIBE_NAME = "tool_describe";
const RESULT_BYTES = 64 * 1024;
const deliveredNames = z.array(z.string());

export const isDiscoveryTool = (name: string) => name === SEARCH_NAME || name === DESCRIBE_NAME;

/** Only complete definitions from paired, successful root discovery count as learned. */
function learned(items: readonly Item[]): Set<string> {
  const calls = new Set(
    items.flatMap((item) =>
      item.type === "tool_call" && !item.parentCallId && isDiscoveryTool(item.name)
        ? [item.callId]
        : [],
    ),
  );
  return new Set(
    items.flatMap((item) =>
      item.type === "tool_result" &&
      !item.parentCallId &&
      item.status === "ok" &&
      calls.has(item.callId)
        ? deliveredNames.parse(item.annotations?.toolDiscovery ?? [])
        : [],
    ),
  );
}

function result(data: unknown, names: string[]): ToolResult {
  const structured = jsonValueSchema.parse(data);
  const text = JSON.stringify(structured);
  if (Buffer.byteLength(text) > RESULT_BYTES)
    throw new Error("tool definition exceeds 64 KiB discovery result limit");
  return {
    forModel: [{ type: "text", text }],
    structured,
    status: "ok",
    annotations: { toolDiscovery: names },
  };
}

function matches(tools: ToolSet, queries: string[], known: ReadonlySet<string>): ToolContract[] {
  const groups = queries.map((query) => [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter(Boolean),
    ),
  ]);
  if (groups.some((words) => words.length === 0))
    throw new Error("tool search queries require keywords");
  if (groups.reduce((count, words) => count + words.length, 0) > 32)
    throw new Error("tool search query exceeds 32 terms");
  return tools
    .schemas()
    .filter((schema) => tools.exposes(schema.name, "code") && !known.has(schema.name))
    .map((schema) => ({
      schema,
      score: Math.max(
        ...groups.map((words) =>
          words.every((word) => `${schema.name} ${schema.description}`.toLowerCase().includes(word))
            ? words.reduce(
                (sum, word) =>
                  sum +
                  (schema.name.toLowerCase().includes(word)
                    ? 3
                    : schema.description.toLowerCase().includes(word)
                      ? 1
                      : 0),
                0,
              )
            : 0,
        ),
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
    .map(({ schema }) => tools.contract(schema.name)!);
}

/** Core metadata inspection, independent of guest execution and plugin output cropping. */
export function discoveryTools(
  tools: ToolSet,
  initialNames: readonly string[],
  active: () => Promise<readonly Item[]>,
): Tool[] {
  return [
    {
      name: SEARCH_NAME,
      description:
        'Find tool definitions by keywords in names and descriptions. Each query requires all its words (AND); queries are alternatives (OR). Example: {"queries":["gitlab issues","gitlab merge requests"]}. Use short keywords, not sentences. Returns up to 12 new definitions, including descriptions and input/output schemas. Already declared or discovered tools are omitted until compaction. more means some matches were omitted: repeat for remaining fitting definitions, or narrow the query for oversized matches. Deferred tools are callable through eval, not directly. Use tool_describe to inspect or refresh a known tool.',
      input: {
        kind: "function",
        schema: z.strictObject({
          queries: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
        }),
      },
      exposure: { direct: true, code: false },
      execute: async (args, ctx) => {
        const known = learned(await active());
        for (const name of initialNames) known.add(name);
        ctx.signal.throwIfAborted();
        const definitions: ToolContract[] = [];
        const oversized: string[] = [];
        const oversizedCandidates: string[] = [];
        let more = false;
        for (const definition of matches(tools, (args as { queries: string[] }).queries, known)) {
          if (
            Buffer.byteLength(JSON.stringify({ tools: [definition], oversized: [], more: false })) >
            RESULT_BYTES
          ) {
            if (oversizedCandidates.length < 12) oversizedCandidates.push(definition.input.name);
            else more = true;
            continue;
          }
          if (
            definitions.length < 12 &&
            Buffer.byteLength(
              JSON.stringify({ tools: [...definitions, definition], oversized, more: false }),
            ) <= RESULT_BYTES
          )
            definitions.push(definition);
          else more = true;
        }
        // Complete callable definitions take priority over omission notices, regardless of rank.
        for (const name of oversizedCandidates) {
          if (
            Buffer.byteLength(
              JSON.stringify({ tools: definitions, oversized: [...oversized, name], more: false }),
            ) <= RESULT_BYTES
          )
            oversized.push(name);
          else more = true;
        }
        return result(
          { tools: definitions, oversized, more },
          definitions.map((definition) => definition.input.name),
        );
      },
    },
    {
      name: DESCRIBE_NAME,
      description:
        "Inspect the current complete definition of a scoped tool: description, input schema or raw-text grammar, and output schema when available. This explicit lookup can refresh an already known definition. Deferred tools are callable through eval, not directly.",
      input: { kind: "function", schema: z.strictObject({ name: z.string().min(1).max(512) }) },
      exposure: { direct: true, code: false },
      execute: async (args) => {
        const name = (args as { name: string }).name;
        if (!tools.has(name)) throw new Error(`unknown tool: ${name}`);
        return result(tools.contract(name)!, [name]);
      },
    },
  ];
}
