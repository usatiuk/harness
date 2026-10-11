import { z } from "zod";
import {
  textOf,
  type ModelOutputItem,
  type ModelRequest,
  type ProviderPayload,
} from "@harness/protocol";

export const thinkingSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.array(z.record(z.string(), z.unknown())),
    signature: z.string().nullish(),
    closed: z.boolean().optional(),
  })
  .passthrough();
export const contentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  thinkingSchema,
  z.object({ type: z.literal("tool_reference") }).passthrough(),
]);
export const entrySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message.output"),
      role: z.literal("assistant"),
      content: z.array(contentSchema),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("function.call"),
      tool_call_id: z.string().min(1),
      name: z.string().min(1),
      arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
    })
    .passthrough(),
]);
export type NativeEntry = z.infer<typeof entrySchema>;

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

/** Readable output order mirrors streaming: message parts, then complete local calls. */
export function outputItems(entries: readonly NativeEntry[]): ModelOutputItem[] {
  const messages: ModelOutputItem[] = [];
  const calls: ModelOutputItem[] = [];
  for (const entry of entries) {
    if (entry.type === "function.call") {
      calls.push({
        type: "tool_call",
        callId: entry.tool_call_id,
        name: entry.name,
        args:
          typeof entry.arguments === "string"
            ? (JSON.parse(entry.arguments) as unknown)
            : entry.arguments,
      });
      continue;
    }
    for (const chunk of entry.content) {
      if (chunk.type === "tool_reference") continue;
      const content =
        chunk.type === "text"
          ? [{ type: "text" as const, text: chunk.text }]
          : chunk.thinking.flatMap((part) =>
              typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [],
            );
      messages.push({ type: chunk.type === "text" ? "message" : "reasoning", content });
    }
  }
  return [...messages, ...calls];
}

export function buildMistralRequest(request: ModelRequest) {
  const inputs: Record<string, unknown>[] = [];

  // Completed native output is anchored to its last canonical item. Replay only
  // a completely selected group; a rewind must never reveal later output.
  const selected = request.items.filter(({ item }) => item.type !== "provider_output");
  const bundles = new Map<number, NativeEntry[]>();
  const covered = new Set<number>();
  for (const [index, { payload }] of selected.entries()) {
    const raw = matchingPayload(payload, request, "mistral-output");
    if (raw === undefined) continue;
    const entries = z.array(entrySchema).parse(raw);
    const expected = outputItems(entries);
    const start = index + 1 - expected.length;
    if (
      start < 0 ||
      !expected.every((part, offset) => {
        const actual = selected[start + offset]!.item;
        if (actual.type !== part.type) return false;
        if (part.type === "tool_call" && actual.type === "tool_call")
          return (
            actual.callId === part.callId &&
            actual.name === part.name &&
            JSON.stringify(actual.args) === JSON.stringify(part.args)
          );
        return (
          (part.type === "message" || part.type === "reasoning") &&
          (actual.type === "message" || actual.type === "reasoning") &&
          (actual.type !== "message" || actual.role === "assistant") &&
          textOf(actual.content) === textOf(part.content)
        );
      })
    )
      continue;
    bundles.set(index, entries);
    for (let part = start; part < index; part++) covered.add(part);
  }
  const nativeArguments = new Map(
    selected.flatMap(({ item, payload }) => {
      if (item.type !== "tool_call") return [];
      const raw = matchingPayload(payload, request, "mistral-tool-arguments");
      return raw === undefined ? [] : [[item.callId, z.string().parse(raw)] as const];
    }),
  );
  const rawCalls = new Set(
    selected.flatMap(({ item }, index) =>
      item.type === "tool_call" &&
      typeof item.args === "string" &&
      !covered.has(index) &&
      !bundles.has(index) &&
      !nativeArguments.has(item.callId)
        ? [item.callId]
        : [],
    ),
  );
  for (const [index, { item, payload }] of selected.entries()) {
    if (covered.has(index)) continue;
    const bundle = bundles.get(index);
    if (bundle) {
      // Conversations rejects output-entry IDs on input; tool_call_id still
      // correlates local calls/results. Leave stored native output untouched.
      inputs.push(
        ...bundle.map((entry) => {
          const input = { ...entry };
          delete input.id;
          return input;
        }),
      );
      continue;
    }
    switch (item.type) {
      case "reasoning": {
        // Existing signed Mistral thinking is also valid Conversations input.
        const raw = matchingPayload(payload, request, "mistral-thinking");
        if (raw !== undefined)
          inputs.push({
            type: "message.input",
            role: "assistant",
            content: [thinkingSchema.parse(raw)],
          });
        break;
      }
      case "message":
        inputs.push({
          type: "message.input",
          role: item.role === "assistant" ? "assistant" : "user",
          content: textOf(item.content),
        });
        break;
      case "tool_call":
        inputs.push(
          rawCalls.has(item.callId)
            ? {
                type: "message.input",
                role: "assistant",
                content: "Tool " + item.name + ": " + String(item.args),
              }
            : {
                type: "function.call",
                tool_call_id: item.callId,
                name: item.name,
                arguments: nativeArguments.get(item.callId) ?? JSON.stringify(item.args),
              },
        );
        break;
      case "tool_result":
        inputs.push(
          rawCalls.has(item.callId)
            ? { type: "message.input", role: "user", content: textOf(item.content) }
            : {
                type: "function.result",
                tool_call_id: item.callId,
                result: textOf(item.content),
              },
        );
        break;
      case "context":
      case "compaction":
        inputs.push({ type: "message.input", role: "user", content: textOf(item.content) });
        break;
    }
  }
  if (request.prompt !== undefined)
    inputs.push({ type: "message.input", role: "user", content: request.prompt });
  const tools: Record<string, unknown>[] = (request.tools ?? []).map((tool) => {
    if (tool.kind !== "function") throw new Error("Mistral supports function tools only");
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });
  if (
    request.providerOptions &&
    typeof request.providerOptions === "object" &&
    !Array.isArray(request.providerOptions) &&
    request.providerOptions.webSearch === true
  )
    tools.push({ type: "web_search" });
  return {
    model: request.modelConfig.model,
    inputs,
    instructions: textOf(request.instructions),
    stream: true,
    store: false,
    tools,
    completion_args: {
      tool_choice: request.toolChoice ?? "auto",
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    },
  };
}
