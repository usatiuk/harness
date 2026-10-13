import { z } from "zod";
import type { CodeEvaluator, Tool, ToolMode, ToolContract } from "@harness/protocol";
import { ToolSet } from "./registry.ts";
import { isDiscoveryTool } from "./tool-discovery.ts";

export const EVALUATOR_NAME = "eval";
const DESCRIPTION = `Run an async JavaScript function body in a fresh, isolated environment.
Use await and return a JSON value. Discover tool definitions using the ordinary tool_search and
tool_describe tools before writing code; tools.call is the only guest tool API.
await tools.call(name, args) invokes a normal governed Harness tool. For custom tools pass a string.
Calls return structured JSON when available, otherwise {content, status, full?, annotations?}.
Failures and denials throw an Error with a result property; caught errors may be handled deliberately.
emit(value) appends JSON output; emitContent(blocks) forwards supported content blocks.
Emitted output survives a later error. Only emitted values and the return value reach the main model.
Each tools.call starts an operation. Await sequentially for order or use Promise.all for concurrent
work. Await all work: outstanding
calls are cancelled when the body ends. Background activity results mean running, not completed;
use activity tools to inspect/wait. No filesystem, network, process, imports, timers, or credentials
are ambient. Discover tools on demand; unavailable names cannot bypass scope. Computation, memory,
output, and tool submissions are bounded. No replay, rollback, or persistent variables.`;

export function upfrontTools(tools: ToolSet): ToolContract[] {
  return tools
    .schemas()
    .filter((schema) => tools.exposes(schema.name, "code") && tools.get(schema.name).essential)
    .map((schema) => tools.contract(schema.name)!);
}

export function evaluatorTool(evaluator: CodeEvaluator, upfront: ToolContract[] = []): Tool {
  return {
    name: EVALUATOR_NAME,
    description:
      DESCRIPTION +
      (upfront.length
        ? `\nThe following tools are already described for use inside eval only. Invoke them with await tools.call(name, args), not as direct calls. For example: await tools.call(${JSON.stringify(upfront[0]!.input.name)}, args).\n${JSON.stringify(upfront)}`
        : ""),
    input: { kind: "function", schema: z.strictObject({ code: z.string().max(64 * 1024) }) },
    exposure: { direct: true, code: false },
    execute: async (args, ctx) => {
      if (!ctx.codeTools) throw new Error("evaluator invocation bridge missing");
      return evaluator.evaluate((args as { code: string }).code, ctx.codeTools, ctx.signal);
    },
  };
}

export function modelSchemas(tools: ToolSet, mode: ToolMode) {
  return tools.schemas().filter((schema) => allowsDirect(tools, schema.name, mode));
}

export function allowsDirect(tools: ToolSet, name: string, mode: ToolMode): boolean {
  return (
    tools.exposes(name, "direct") &&
    (mode === "direct" ||
      name === EVALUATOR_NAME ||
      isDiscoveryTool(name) ||
      (mode === "hybrid" && tools.get(name).essential === true))
  );
}
