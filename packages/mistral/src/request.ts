import { createHash } from "node:crypto";
import { z } from "zod";
import { textOf, type ModelRequest, type ProviderPayload } from "@harness/protocol";

export const thinkingSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.array(z.record(z.string(), z.unknown())),
    signature: z.string().nullish(),
    closed: z.boolean().optional(),
  })
  .passthrough();
export const nativeContentSchema = z.array(
  z.union([z.object({ type: z.literal("text"), text: z.string() }).passthrough(), thinkingSchema]),
);
export type NativeContent = z.infer<typeof nativeContentSchema>;
export type NativeThinking = z.infer<typeof thinkingSchema>;
interface NativeAssistant {
  role: "assistant";
  content: NativeContent;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export function matchingPayload(
  payload: ProviderPayload | undefined,
  request: ModelRequest,
  type: string,
): unknown {
  if (
    !payload ||
    payload.provider !== request.modelConfig.provider ||
    payload.model !== request.modelConfig.model ||
    payload.type !== type
  )
    return undefined;
  if (payload.version !== 1) throw new Error("Unsupported Mistral continuation payload version");
  return payload.payload;
}

/** Mistral requires nine alphanumeric call IDs, including imported provider history. */
export function nativeCallId(id: string): string {
  return /^[a-zA-Z0-9]{9}$/.test(id)
    ? id
    : createHash("sha256")
        .update(id)
        .digest("base64")
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 9);
}

export function buildMistralRequest(request: ModelRequest) {
  const messages: Record<string, unknown>[] = [];
  if (request.instructions.length)
    messages.push({ role: "system", content: textOf(request.instructions) });
  let assistant: NativeAssistant | undefined;
  const callIds = new Map<string, string>();
  const names = new Map<string, string>();
  const idFor = (canonical: string) => {
    const id = nativeCallId(canonical);
    const prior = callIds.get(id);
    if (prior !== undefined && prior !== canonical)
      throw new Error("Mistral tool call ID collision");
    callIds.set(id, canonical);
    return id;
  };
  const flush = () => {
    if (assistant) messages.push(assistant as unknown as Record<string, unknown>);
    assistant = undefined;
  };
  const current = () => (assistant ??= { role: "assistant", content: [] });
  for (const { item, payload } of request.items) {
    switch (item.type) {
      case "reasoning": {
        const raw = matchingPayload(payload, request, "mistral-thinking");
        current().content.push(
          raw === undefined
            ? { type: "thinking", thinking: item.content }
            : thinkingSchema.parse(raw),
        );
        break;
      }
      case "message":
        if (item.role === "assistant") {
          current().content.push({ type: "text", text: textOf(item.content) });
        } else {
          flush();
          messages.push({ role: item.role, content: textOf(item.content) });
        }
        break;
      case "tool_call": {
        const raw = matchingPayload(payload, request, "mistral-tool-arguments");
        const args = raw === undefined ? JSON.stringify(item.args) : z.string().parse(raw);
        names.set(item.callId, item.name);
        (current().tool_calls ??= []).push({
          id: idFor(item.callId),
          type: "function",
          function: { name: item.name, arguments: args },
        });
        break;
      }
      case "tool_result":
        flush();
        messages.push({
          role: "tool",
          tool_call_id: idFor(item.callId),
          ...(names.has(item.callId) ? { name: names.get(item.callId) } : {}),
          content: textOf(item.content),
        });
        break;
      case "compaction":
      case "context":
        flush();
        messages.push({ role: "user", content: textOf(item.content) });
        break;
    }
  }
  flush();
  if (request.prompt !== undefined) messages.push({ role: "user", content: request.prompt });
  const tools = (request.tools ?? []).map((tool) => {
    if (tool.kind !== "function") throw new Error("Mistral supports function tools only");
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });
  return {
    model: request.modelConfig.model,
    messages,
    stream: true,
    ...(tools.length ? { tools, parallel_tool_calls: true } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
  };
}
