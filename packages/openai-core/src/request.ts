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
function toInputItem(item: Item, payload?: ProviderPayload): InputItem | undefined {
  switch (item.type) {
    case "message":
      return { role: item.role, content: textOf(item.content) };
    case "reasoning": {
      // Replayable only with our own opaque blob; a foreign/absent payload is skipped
      // rather than sent as bare summary text (the API rejects that).
      const stored = readReasoningPayload(payload);
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
      return {
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.args),
      };
    case "tool_result":
      return { type: "function_call_output", call_id: item.callId, output: textOf(item.content) };
  }
}

function toFunctionTool(schema: ToolSchema): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    strict: false,
  };
}

/** Maps a harness `ModelRequest` onto native Responses streaming params. */
export function buildResponseParams(
  request: ModelRequest,
  reasoning: OpenAI.Reasoning,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const input: InputItem[] = [];
  for (const { item, payload } of request.items) {
    const mapped = toInputItem(item, payload);
    if (mapped) input.push(mapped);
  }
  const tools = request.tools?.map(toFunctionTool) ?? [];
  return {
    model: request.modelConfig.model,
    instructions: textOf(request.instructions),
    input,
    stream: true,
    store: false, // stateless: we own the log and round-trip reasoning via encrypted_content
    include: ["reasoning.encrypted_content"],
    reasoning,
    ...(tools.length > 0 ? { tools } : {}),
  };
}
