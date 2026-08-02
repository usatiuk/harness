import type OpenAI from "openai";
import type {
  ContentBlock,
  Item,
  ModelRequest,
  ProviderPayload,
  ToolSchema,
} from "@harness/protocol";
import { readReasoningPayload } from "./payload.ts";

type InputItem = OpenAI.Responses.ResponseInputItem;

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** One log item → one Responses input item, or `undefined` to omit it. */
function toInputItem(
  item: Item,
  provider: string,
  model: string,
  // Call ids whose tool is freeform this turn — rendered as `custom_tool_call` rather than
  // a JSON function call.
  freeformCallIds: ReadonlySet<string>,
  payload?: ProviderPayload,
): InputItem | undefined {
  switch (item.type) {
    case "message":
      return { role: item.role, content: textOf(item.content) };
    case "reasoning": {
      // Replayable only with our own opaque blob; a mismatched/absent payload is skipped
      // rather than sent as bare summary text (the API rejects that).
      const stored = readReasoningPayload(payload, provider, model);
      if (!stored) return undefined;
      return {
        type: "reasoning",
        id: stored.id,
        summary: item.content
          .filter((b) => b.type === "text")
          .map((b) => ({ type: "summary_text" as const, text: b.text })),
        encrypted_content: stored.encryptedContent,
      };
    }
    case "tool_call":
      // A freeform tool's canonical args are the raw input string; round-trip it natively.
      if (freeformCallIds.has(item.callId)) {
        return {
          type: "custom_tool_call",
          call_id: item.callId,
          name: item.name,
          input: item.args as string,
        };
      }
      return {
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.args),
      };
    case "tool_result":
      if (freeformCallIds.has(item.callId)) {
        return {
          type: "custom_tool_call_output",
          call_id: item.callId,
          output: textOf(item.content),
        };
      }
      return { type: "function_call_output", call_id: item.callId, output: textOf(item.content) };
    case "compaction":
      // No provider concept for a fold; send it as a plain user message.
      return { role: "user", content: textOf(item.content) };
    case "context":
      // Plugin-injected context (e.g. an AGENTS.md); a developer message.
      return { role: "developer", content: textOf(item.content) };
  }
}

function toFunctionTool(
  schema: Extract<ToolSchema, { kind: "function" }>,
): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    strict: false,
  };
}

/** A custom (freeform) tool → a `custom` tool, grammar-constrained when the schema carries one. */
function toCustomTool(
  schema: Extract<ToolSchema, { kind: "custom" }>,
): OpenAI.Responses.CustomTool {
  const grammar = schema.grammar;
  return {
    type: "custom",
    name: schema.name,
    description: schema.description,
    format: grammar
      ? { type: "grammar", syntax: grammar.syntax, definition: grammar.definition }
      : { type: "text" },
  };
}

/** Maps a harness `ModelRequest` onto native Responses streaming params. */
export function buildResponseParams(
  request: ModelRequest,
  reasoning: OpenAI.Reasoning,
  provider: string,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Freeform tools round-trip as `custom_tool_call` items. A tool_result carries only its
  // callId, so pre-scan the calls to know which results render as custom output.
  const freeformNames = new Set(
    request.tools?.filter((t) => t.kind === "custom").map((t) => t.name) ?? [],
  );
  const freeformCallIds = new Set<string>();
  for (const { item } of request.items) {
    if (item.type === "tool_call" && freeformNames.has(item.name)) freeformCallIds.add(item.callId);
  }

  const input: InputItem[] = [];
  for (const { item, payload } of request.items) {
    const mapped = toInputItem(item, provider, request.modelConfig.model, freeformCallIds, payload);
    if (mapped) input.push(mapped);
  }
  if (request.prompt) {
    input.push({ role: "user", content: request.prompt });
  }

  // `native` tools are a provider's own built-ins; no OpenAI model offers one (they arrive only
  // under the `text_editor` profile), so encountering one is a wiring bug, not a runtime input.
  const tools: OpenAI.Responses.Tool[] =
    request.tools?.map((t) => {
      if (t.kind === "custom") return toCustomTool(t);
      if (t.kind === "native") throw new Error(`openai cannot render native tool: ${t.name}`);
      return toFunctionTool(t);
    }) ?? [];

  return {
    model: request.modelConfig.model,
    instructions: textOf(request.instructions),
    input,
    stream: true,
    store: false, // stateless: we own the log and round-trip reasoning via encrypted_content
    include: ["reasoning.encrypted_content"],
    reasoning,
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}
