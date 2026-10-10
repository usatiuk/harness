import { z } from "zod";
import {
  jsonValueSchema,
  type ModelOutputItem,
  type ModelStreamEvent,
  type Usage,
} from "@harness/protocol";
import { contentSchema, outputItems, type NativeEntry } from "./request.ts";

const count = z.number().int().nonnegative();
const usageSchema = z
  .object({
    prompt_tokens: count.optional(),
    completion_tokens: count.optional(),
    prompt_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  })
  .passthrough()
  .refine(
    (usage) =>
      usage.prompt_tokens === undefined ||
      (usage.prompt_tokens_details?.cached_tokens ?? 0) <= usage.prompt_tokens,
  );
const eventSchema = z.object({ type: z.string() }).passthrough();
const positionSchema = z.object({ output_index: count.default(0), id: z.string().min(1) });
const messageSchema = positionSchema.extend({
  content_index: count.default(0),
  role: z.literal("assistant").default("assistant"),
  model: z.string().nullish(),
  agent_id: z.string().nullish(),
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
});
const callSchema = positionSchema.extend({
  name: z.string().min(1),
  tool_call_id: z.string().min(1),
  arguments: z.string(),
});
type Chunk = z.infer<typeof contentSchema>;
type Message = Extract<NativeEntry, { type: "message.output" }>;
type MessageDraft = Omit<Message, "content" | "type"> & {
  type: "message.output";
  content: Map<number, Chunk>;
};
type Call = Extract<NativeEntry, { type: "function.call" }>;
type CallDraft = Omit<Call, "arguments" | "type"> & {
  type: "function.call";
  arguments: string;
  name: string;
  tool_call_id: string;
};

export async function* mistralEvents(
  stream: AsyncIterable<unknown>,
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const entries = new Map<number, { id: string; entry: MessageDraft | CallDraft }>();
  let pending: { output: number; content: number } | undefined;
  let error: string | undefined;
  let searched = false;
  let reported: z.infer<typeof usageSchema> | null | undefined;
  const flush = () => {
    if (!pending) return undefined;
    const entry = entries.get(pending.output)?.entry;
    if (!entry || entry.type !== "message.output") throw new Error("Missing Mistral message draft");
    const chunk = entry.content.get(pending.content);
    if (!chunk) throw new Error("Missing Mistral content draft");
    const [item] = outputItems([{ type: "message.output", role: "assistant", content: [chunk] }]);
    if (!item) throw new Error("Mistral visible content has no output item");
    pending = undefined;
    return item;
  };
  const completed = (): Extract<ModelStreamEvent, { type: "completed" }> => ({
    type: "completed",
    usage:
      reported?.prompt_tokens !== undefined && reported.completion_tokens !== undefined
        ? ({
            inputTokens: reported.prompt_tokens,
            outputTokens: reported.completion_tokens,
            cachedReadTokens: reported.prompt_tokens_details?.cached_tokens ?? 0,
          } satisfies Usage)
        : null,
    ...(reported ? { providerUsage: jsonValueSchema.parse(reported) } : {}),
    ...(searched ? { costIncomplete: true, inputTokensAreContext: false } : {}),
    ...(error ? { error } : {}),
  });
  try {
    for await (const raw of stream) {
      const event = eventSchema.parse(raw);
      if (event.type === "conversation.response.done") {
        reported = z.object({ usage: usageSchema.nullish() }).parse(raw).usage;
        const native: NativeEntry[] = [...entries]
          .sort(([a], [b]) => a - b)
          .map(([, { entry }]) =>
            entry.type === "message.output"
              ? {
                  ...entry,
                  role: "assistant",
                  content: [...entry.content].sort(([a], [b]) => a - b).map(([, chunk]) => chunk),
                }
              : entry,
          );
        let calls: ModelOutputItem[] = [];
        if (!error) {
          try {
            const ids = new Set<string>();
            for (const entry of native) {
              if (entry.type !== "function.call") continue;
              if (ids.has(entry.tool_call_id)) throw new Error();
              ids.add(entry.tool_call_id);
              if (typeof entry.arguments === "string") JSON.parse(entry.arguments);
            }
            calls = outputItems(native.filter((entry) => entry.type === "function.call"));
          } catch {
            error = "Mistral returned malformed or duplicate tool calls";
          }
        }
        const last = flush();
        const final = [...(last ? [last] : []), ...calls];
        // No entry-completion events exist: signed native history becomes valid
        // only at response.done, anchored to the final immutable output item.
        if (!error && final.length)
          final.at(-1)!.payload = {
            provider,
            model,
            type: "mistral-output",
            version: 1,
            payload: jsonValueSchema.parse(native),
          };
        yield* final;
        yield completed();
        return;
      }
      signal.throwIfAborted();
      if (event.type === "conversation.response.error") {
        const failure = z.object({ message: z.string(), code: z.number() }).parse(raw);
        error = `Mistral response error (${failure.code}): ${failure.message}`;
        const last = flush();
        if (last) yield last;
        yield completed();
        return;
      }
      if (event.type === "conversation.response.started") continue;
      if (event.type.startsWith("tool.execution.")) {
        const tool = z
          .object({
            name: z.string(),
            type: z.enum(["tool.execution.started", "tool.execution.delta", "tool.execution.done"]),
          })
          .parse(raw);
        searched = true;
        if (tool.type === "tool.execution.started")
          yield {
            type: "provider_output",
            content: [{ type: "text", text: "Used " + tool.name + "." }],
          };
        continue;
      }
      if (event.type === "function.call.delta") {
        const delta = callSchema.parse(raw);
        const stored = entries.get(delta.output_index);
        if (
          stored &&
          (stored.id !== delta.id ||
            stored.entry.type !== "function.call" ||
            stored.entry.name !== delta.name ||
            stored.entry.tool_call_id !== delta.tool_call_id)
        )
          throw new Error("Mistral changed function identity during streaming");
        const entry: CallDraft = stored
          ? (stored.entry as CallDraft)
          : {
              type: "function.call",
              id: delta.id,
              tool_call_id: delta.tool_call_id,
              name: delta.name,
              arguments: "",
            };
        entry.arguments += delta.arguments;
        entries.set(delta.output_index, { id: delta.id, entry });
        continue;
      }
      if (event.type !== "message.output.delta") {
        error ??= "Mistral returned unsupported event: " + event.type;
        continue;
      }
      const delta = messageSchema.parse(raw);
      const parsed = contentSchema.safeParse(
        typeof delta.content === "string" ? { type: "text", text: delta.content } : delta.content,
      );
      if (!parsed.success) {
        error ??= "Mistral returned unsupported output chunk";
        continue;
      }
      const chunk = parsed.data;
      const stored = entries.get(delta.output_index);
      if (stored && (stored.id !== delta.id || stored.entry.type !== "message.output"))
        throw new Error("Mistral changed message identity during streaming");
      const entry: MessageDraft = stored
        ? (stored.entry as MessageDraft)
        : {
            type: "message.output",
            id: delta.id,
            role: "assistant",
            content: new Map(),
            ...(delta.model !== undefined ? { model: delta.model } : {}),
            ...(delta.agent_id !== undefined ? { agent_id: delta.agent_id } : {}),
          };
      const prior = entry.content.get(delta.content_index);
      if (prior && prior.type !== chunk.type)
        throw new Error("Mistral returned inconsistent content indices");
      let merged: Chunk = chunk;
      if (prior?.type === "text" && chunk.type === "text")
        merged = { ...prior, ...chunk, text: prior.text + chunk.text };
      if (prior?.type === "thinking" && chunk.type === "thinking") {
        prior.thinking.push(...chunk.thinking);
        merged = { ...prior, ...chunk, thinking: prior.thinking };
      }
      entry.content.set(delta.content_index, merged);
      entries.set(delta.output_index, { id: delta.id, entry });
      if (chunk.type === "tool_reference") continue;
      const changed =
        pending &&
        (pending.output !== delta.output_index || pending.content !== delta.content_index);
      if (changed) {
        if (
          delta.output_index < pending!.output ||
          (delta.output_index === pending!.output && delta.content_index < pending!.content)
        )
          throw new Error("Mistral returned out-of-order visible output");
        const last = flush();
        if (last) yield last;
      }
      pending = { output: delta.output_index, content: delta.content_index };
      const text =
        chunk.type === "text"
          ? chunk.text
          : chunk.thinking.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
      if (text) yield { type: chunk.type === "text" ? "text_delta" : "reasoning_delta", text };
    }
    signal.throwIfAborted();
    throw new Error("Mistral stream ended without response completion");
  } catch (cause) {
    const last = flush();
    if (last) yield last;
    throw cause;
  }
}
