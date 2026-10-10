import { z } from "zod";
import { type ModelStreamEvent, type Usage } from "@harness/protocol";
import { nativeContentSchema, type NativeThinking } from "./request.ts";

const count = z.number().int().nonnegative();
const usageSchema = z
  .object({
    prompt_tokens: count.optional(),
    completion_tokens: count.optional(),
    prompt_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  })
  .refine(
    (usage) =>
      usage.prompt_tokens === undefined ||
      (usage.prompt_tokens_details?.cached_tokens ?? 0) <= usage.prompt_tokens,
  );
const chunkSchema = z.object({
  usage: usageSchema.nullish(),
  choices: z
    .array(
      z.object({
        index: z.literal(0).optional(),
        finish_reason: z.string().nullish(),
        delta: z.object({
          content: z.union([z.string(), nativeContentSchema]).nullish(),
          tool_calls: z
            .array(
              z.object({
                index: count.optional(),
                id: z.string().optional(),
                type: z.literal("function").optional(),
                function: z.object({
                  name: z.string().optional(),
                  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
                }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .max(1),
});
interface PendingCall {
  id?: string;
  name: string;
  arguments: string;
}

function appendThinking(last: NativeThinking, chunk: NativeThinking) {
  last.thinking.push(...chunk.thinking);
  // Preserve opaque additions on the native block as well as its known fields.
  for (const [key, value] of Object.entries(chunk))
    if (key !== "type" && key !== "thinking")
      Object.defineProperty(last, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
}

export async function* mistralEvents(
  stream: AsyncIterable<unknown>,
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const calls = new Map<number, PendingCall>();
  let thinking: NativeThinking | undefined;
  let reasoning = "";
  let usage: Usage | null = null;
  let finish: string | undefined;
  const flushThinking = (): Extract<ModelStreamEvent, { type: "reasoning" }> | undefined => {
    if (!thinking) return undefined;
    const event: Extract<ModelStreamEvent, { type: "reasoning" }> = {
      type: "reasoning",
      content: reasoning ? [{ type: "text", text: reasoning }] : [],
      payload: { provider, model, type: "mistral-thinking", version: 1, payload: thinking },
    };
    thinking = undefined;
    reasoning = "";
    return event;
  };
  for await (const raw of stream) {
    signal.throwIfAborted();
    const parsed = chunkSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Mistral stream returned invalid content or accounting");
    const chunk = parsed.data;
    if (chunk.usage) {
      const reported = chunk.usage;
      usage =
        reported.prompt_tokens !== undefined && reported.completion_tokens !== undefined
          ? ({
              inputTokens: reported.prompt_tokens,
              outputTokens: reported.completion_tokens,
              cachedReadTokens: reported.prompt_tokens_details?.cached_tokens ?? 0,
            } satisfies Usage)
          : null;
    }
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (finish !== undefined)
      throw new Error("Mistral stream returned output after its finish reason");
    const pieces =
      typeof choice.delta.content === "string"
        ? [{ type: "text" as const, text: choice.delta.content }]
        : (choice.delta.content ?? []);
    for (const piece of pieces) {
      if (piece.type === "text") {
        const finalized = flushThinking();
        if (finalized) yield finalized;
        if (piece.text) yield { type: "text_delta", text: piece.text };
      } else {
        if (thinking?.closed === true) {
          const finalized = flushThinking();
          if (finalized) yield finalized;
        }
        if (thinking) appendThinking(thinking, piece);
        else thinking = structuredClone(piece);
        const text = piece.thinking
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("");
        reasoning += text;
        if (text) yield { type: "reasoning_delta", text };
      }
    }
    for (const [position, part] of (choice.delta.tool_calls ?? []).entries()) {
      const index = part.index ?? position;
      const call = calls.get(index) ?? { name: "", arguments: "" };
      if (part.id) {
        // Native Mistral can stream fragments or repeat the accumulated ID.
        if (!call.id || part.id.startsWith(call.id)) call.id = part.id;
        else if (!call.id.endsWith(part.id)) call.id += part.id;
      }
      if (part.function.name) call.name += part.function.name;
      if (part.function.arguments !== undefined)
        call.arguments +=
          typeof part.function.arguments === "string"
            ? part.function.arguments
            : JSON.stringify(part.function.arguments);
      calls.set(index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  signal.throwIfAborted();
  if (finish === undefined) throw new Error("Mistral stream ended without a finish reason");
  const outputs: Extract<ModelStreamEvent, { type: "tool_call" }>[] = [];
  let error: string | undefined;
  if (finish === "tool_calls") {
    const ids = new Set<string>();
    try {
      if (!calls.size) throw new Error();
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        if (!call.id || !/^[a-zA-Z0-9]{9}$/.test(call.id) || !call.name || ids.has(call.id))
          throw new Error();
        ids.add(call.id);
        outputs.push({
          type: "tool_call",
          callId: call.id,
          name: call.name,
          args: JSON.parse(call.arguments) as unknown,
          payload: {
            provider,
            model,
            type: "mistral-tool-arguments",
            version: 1,
            payload: call.arguments,
          },
        });
      }
    } catch {
      error = "Mistral returned malformed or duplicate tool calls";
    }
  } else if (finish !== "stop" || calls.size)
    error =
      finish === "length"
        ? "Mistral output was truncated at the model limit"
        : finish === "content_filter"
          ? "Mistral output was blocked by the content filter"
          : "Mistral returned an unsupported finish reason or unfinished tool calls";
  const finalized = flushThinking();
  if (finalized) yield finalized;
  if (!error) yield* outputs;
  yield { type: "completed", usage, ...(error ? { error } : {}) };
}
