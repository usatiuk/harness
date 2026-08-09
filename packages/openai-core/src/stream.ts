import type OpenAI from "openai";
import type { ModelStreamEvent } from "@harness/protocol";
import { encodeReasoningPayload } from "./payload.ts";

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

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
          usage: {
            inputTokens: event.response.usage?.input_tokens ?? 0,
            outputTokens: event.response.usage?.output_tokens ?? 0,
            // Already a subset of input_tokens — matches the Usage normalization.
            cachedReadTokens: event.response.usage?.input_tokens_details?.cached_tokens ?? 0,
          },
        };
        break;
      case "response.failed":
        throw new Error(`openai response failed: ${event.response.error?.message ?? "unknown"}`);
      case "response.incomplete":
        throw new Error(
          `openai response incomplete: ${event.response.incomplete_details?.reason ?? "unknown"}`,
        );
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
 * Usage arrives on a final `include_usage` tail chunk; if the backend finishes
 * without one, `completed` is still emitted (zeroed usage) so the engine never
 * sees a stream that ends without a terminal event.
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
      // Tool calls are only usable when the model stopped to call them; a
      // length-truncated turn produced no complete call.
      if (choice.finish_reason === "tool_calls") {
        for (const call of toolCalls.values()) {
          if (!call.id) continue;
          yield {
            type: "tool_call",
            callId: call.id,
            name: call.name,
            args: parseArgs(call.arguments),
          };
        }
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
  // terminal `finish_reason` was still observed, so the turn legitimately
  // completed — emit zeroed usage so the engine records the step instead of
  // throwing on a missing `completed` event. A stream that ended without a
  // finish reason at all died mid-flight: emit nothing, and the engine's
  // "provider stream ended without a 'completed' event" error surfaces it while
  // recording no spend.
  if (usage) {
    yield {
      type: "completed",
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cachedReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  } else if (sawTerminalFinish) {
    yield {
      type: "completed",
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
    };
  }
}
