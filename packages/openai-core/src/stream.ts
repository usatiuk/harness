import type OpenAI from "openai";
import type { ModelStreamEvent, Usage } from "@harness/protocol";
import { encodeReasoningPayload } from "./payload.ts";

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function responseUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): Usage | null {
  if (!usage) return null;
  const writes = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    // GPT-5.6+ reports writes separately; the only cache TTL is 30 minutes.
    ...(writes ? { cacheWriteTokens: { 1800: writes } } : {}),
  };
}

/** The raw reasoning_content field chat backends stream; untyped in the SDK. */
interface ReasoningDelta {
  reasoning_content?: string | null;
}

/** A completed output item → its model event(s). Messages arrive via text deltas. */
function* fromItem(
  item: OpenAI.Responses.ResponseOutputItem,
  provider: string,
  model: string,
): Iterable<ModelStreamEvent> {
  if (item.type === "reasoning") {
    const content = item.summary.map((s) => ({ type: "text" as const, text: s.text }));
    const payload = encodeReasoningPayload(item, provider, model);
    yield { type: "reasoning", content, ...(payload ? { payload } : {}) };
  } else if (item.type === "function_call") {
    yield {
      type: "tool_call",
      callId: item.call_id,
      name: item.name,
      args: parseArgs(item.arguments),
    };
  } else if (item.type === "custom_tool_call") {
    // A freeform tool's raw input string is the canonical, provider-neutral args; the tool
    // owns parsing it (e.g. apply_patch parses its V4A envelope).
    yield { type: "tool_call", callId: item.call_id, name: item.name, args: item.input };
  }
}

/** Tolerate malformed argument JSON by passing the raw string through to the tool. */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Translates the native Responses event stream into our provider-agnostic
 * `ModelStreamEvent`s. Output is emitted before `completed`; the terminal event
 * carries usage and optional fidelity metadata only. Terminal failures throw.
 */
export async function* toModelEvents(
  stream: AsyncIterable<StreamEvent>,
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  for await (const event of stream) {
    if (signal.aborted) return;
    switch (event.type) {
      case "response.output_text.delta":
        yield { type: "text_delta", text: event.delta };
        break;
      case "response.reasoning_summary_text.delta":
        yield { type: "reasoning_delta", text: event.delta };
        break;
      case "response.output_item.done":
        yield* fromItem(event.item, provider, model);
        break;
      case "response.completed":
        yield {
          type: "completed",
          usage: responseUsage(event.response.usage),
        };
        break;
      case "response.failed":
        throw new Error(`openai response failed: ${event.response.error?.message ?? "unknown"}`);
      case "response.incomplete":
        yield {
          type: "completed",
          usage: responseUsage(event.response.usage),
          error: `openai response incomplete: ${event.response.incomplete_details?.reason ?? "unknown"}`,
        };
        break;
      case "error":
        throw new Error(`openai stream error: ${event.message}`);
      default:
        break; // the many event types we don't consume (audio, web search, …)
    }
  }
}

/** A tool call being assembled from fragmented streamed deltas. */
interface PendingToolCall {
  id?: string;
  name: string;
  arguments: string;
}

/**
 * Translates a chat/completions SSE stream into provider-neutral events.
 *
 * Reasoning arrives via the untyped `delta.reasoning_content` field and is emitted
 * as `reasoning_delta` for display; the finalized `reasoning` output item is
 * emitted immediately before ANY following output from the same choice (first
 * `content` delta or a `tool_calls` finish) so the log stays `[reasoning, …]` and
 * the outbound merge can round-trip it. A reasoning-only choice emits it at the
 * terminal finish. Reasoning carries no replayable payload — chat is plaintext.
 * Reasoning streamed AFTER the item was finalized cannot be folded into it, so the
 * transport fails fast rather than silently dropping the trailing text.
 *
 * Usage arrives on a final `include_usage` tail chunk. A backend that terminates
 * without it completes with explicitly unknown usage. Truncation, filtering, and
 * malformed calls are terminal errors carried through completion so accounting
 * can be recorded before the engine fails the turn.
 */
export async function* toChatEvents(
  stream: AsyncIterable<ChatChunk>,
  // Chat encodes no provider/model payload fields, but both name the failing
  // backend in the interleaved-reasoning error.
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  let reasoningText = "";
  let reasoningEmitted = false;
  const toolCalls = new Map<number, PendingToolCall>();
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  // Set when the choice announces a terminal state (`stop`/`length`/`tool_calls`),
  // distinguishing a backend that just omitted the usage tail from one that died.
  let sawTerminalFinish = false;
  let terminalError: string | undefined;

  for await (const chunk of stream) {
    if (signal.aborted) return;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta &
      ReasoningDelta;

    // Reasoning is collected (and shown live) until the next output boundary. A
    // chunk may carry both `reasoning_content` and the first `content`/`tool_calls`
    // delta, so accumulate first and fall through rather than `continue` (which
    // would silently drop that boundary output).
    if (delta.reasoning_content) {
      // Reasoning after the item was finalized can't be folded into it. Fail fast
      // rather than silently dropping the trailing text — DeepSeek requires the
      // full reasoning of a tool-calling turn to be passed back.
      if (reasoningEmitted) {
        throw new Error(
          `chat stream interleaved reasoning after output for ${provider}/${model}; trailing reasoning cannot round-trip`,
        );
      }
      reasoningText += delta.reasoning_content;
      yield { type: "reasoning_delta", text: delta.reasoning_content };
    }

    // First non-reasoning output finalizes the pending reasoning item. A null
    // content (role-only chunk) is not output, so it doesn't trigger the boundary.
    if (delta.content && !reasoningEmitted && reasoningText.length > 0) {
      yield { type: "reasoning", content: [{ type: "text", text: reasoningText }] };
      reasoningEmitted = true;
    }
    if (delta.content) {
      yield { type: "text_delta", text: delta.content };
    }

    for (const part of delta.tool_calls ?? []) {
      const pending = toolCalls.get(part.index) ?? { name: "", arguments: "" };
      if (part.id) pending.id = part.id;
      if (part.function?.name) pending.name += part.function.name;
      if (part.function?.arguments) pending.arguments += part.function.arguments;
      toolCalls.set(part.index, pending);
    }

    if (choice.finish_reason) {
      sawTerminalFinish = true;
      // Reasoning-only turns and reasoning-then-tools turns finish their item here.
      if (!reasoningEmitted && reasoningText.length > 0) {
        yield { type: "reasoning", content: [{ type: "text", text: reasoningText }] };
        reasoningEmitted = true;
      }
      if (choice.finish_reason === "tool_calls") {
        const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);
        const malformed = ordered.find(([, call]) => !call.id || !call.name);
        const seenIds = new Set<string>();
        const duplicate = ordered.find(([, call]) => {
          if (!call.id) return false;
          if (seenIds.has(call.id)) return true;
          seenIds.add(call.id);
          return false;
        });
        if (duplicate) {
          terminalError = `chat stream finished with duplicate tool call id '${duplicate[1].id}' at index ${duplicate[0]} for ${provider}/${model}`;
        } else if (ordered.length === 0 || malformed) {
          const detail = malformed ? ` at index ${malformed[0]}` : "";
          terminalError = `chat stream finished with malformed tool call${detail} for ${provider}/${model}`;
        } else {
          for (const [, call] of ordered) {
            yield {
              type: "tool_call",
              callId: call.id!,
              name: call.name,
              args: parseArgs(call.arguments),
            };
          }
        }
      } else if (choice.finish_reason === "length") {
        terminalError = `chat output truncated at the model limit for ${provider}/${model}`;
      } else if (choice.finish_reason === "content_filter") {
        terminalError = `chat output blocked by the content filter for ${provider}/${model}`;
      } else if (choice.finish_reason !== "stop") {
        terminalError = `chat stream ended with unsupported finish reason '${choice.finish_reason}' for ${provider}/${model}`;
      } else if (toolCalls.size > 0) {
        terminalError = `chat stream ended with unfinished tool calls for ${provider}/${model}`;
      }
      toolCalls.clear();
    }
  }

  // A stream that produced reasoning but never hit a content/tool boundary still
  // persists its reasoning item.
  if (!reasoningEmitted && reasoningText.length > 0) {
    yield { type: "reasoning", content: [{ type: "text", text: reasoningText }] };
  }

  // A usage tail only arrives with `include_usage`; many backends omit it. A
  // terminal `finish_reason` still completes with explicit unknown accounting.
  // A stream that ended without a finish reason died mid-flight: emit nothing, and the engine's
  // "provider stream ended without a 'completed' event" error surfaces it while
  // recording no spend.
  if (sawTerminalFinish) {
    yield {
      type: "completed",
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cachedReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        : null,
      ...(terminalError ? { error: terminalError } : {}),
    };
  }
}
