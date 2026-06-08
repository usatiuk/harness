import type OpenAI from "openai";
import {
  APPLY_PATCH,
  type ContentBlock,
  type Item,
  type ModelRequest,
  type ProviderPayload,
  type ToolSchema,
} from "@harness/protocol";
import { readReasoningPayload } from "./payload.ts";

type InputItem = OpenAI.Responses.ResponseInputItem;
type ApplyPatchOperation = OpenAI.Responses.ResponseInputItem.ApplyPatchCall["operation"];

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** One log item → one Responses input item, or `undefined` to omit it. */
function toInputItem(
  item: Item,
  model: string,
  // Call ids rendered in apply_patch's native shape, or `null` outside native-patch mode.
  applyPatchCallIds: ReadonlySet<string> | null,
  payload?: ProviderPayload,
): InputItem | undefined {
  switch (item.type) {
    case "message":
      return { role: item.role, content: textOf(item.content) };
    case "reasoning": {
      // Replayable only with our own opaque blob; a mismatched/absent payload is skipped
      // rather than sent as bare summary text (the API rejects that).
      const stored = readReasoningPayload(payload, model);
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
      // apply_patch round-trips in its native item shape; args are already the operation.
      if (applyPatchCallIds && item.name === APPLY_PATCH) {
        return {
          type: "apply_patch_call",
          call_id: item.callId,
          status: "completed",
          operation: item.args as ApplyPatchOperation,
        };
      }
      return {
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.args),
      };
    case "tool_result":
      if (applyPatchCallIds?.has(item.callId)) {
        return {
          type: "apply_patch_call_output",
          call_id: item.callId,
          status: item.status === "ok" ? "completed" : "failed",
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
  nativeTools: boolean,
): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Render the patch editor in its trained `apply_patch` wire form (and round-trip its
  // history items natively) only when it is both enabled and offered this turn. A
  // tool_result carries only its callId, so pre-scan the calls to know which results
  // render as apply_patch output; `null` means the generic function-calling path.
  const useApplyPatch =
    nativeTools && (request.tools?.some((t) => t.name === APPLY_PATCH) ?? false);
  let applyPatchCallIds: ReadonlySet<string> | null = null;
  if (useApplyPatch) {
    const ids = new Set<string>();
    for (const { item } of request.items) {
      if (item.type === "tool_call" && item.name === APPLY_PATCH) ids.add(item.callId);
    }
    applyPatchCallIds = ids;
  }

  const input: InputItem[] = [];
  for (const { item, payload } of request.items) {
    const mapped = toInputItem(item, request.modelConfig.model, applyPatchCallIds, payload);
    if (mapped) input.push(mapped);
  }

  // apply_patch renders as the native wire tool below, not as a JSON function.
  const tools: OpenAI.Responses.Tool[] =
    request.tools?.filter((t) => !(useApplyPatch && t.name === APPLY_PATCH)).map(toFunctionTool) ??
    [];
  if (useApplyPatch) tools.push({ type: "apply_patch" });

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
