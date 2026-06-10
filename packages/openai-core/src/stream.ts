import type OpenAI from "openai";
import type { ModelStreamEvent } from "@harness/protocol";
import { encodeReasoningPayload } from "./payload.ts";

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

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
 * `ModelStreamEvent`s. `*_delta` events drive live display; `output_item.done` and
 * `completed` carry the authoritative items. Terminal failures throw.
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
        // Canonical text is reconstructed from the streamed deltas, so content is empty.
        yield {
          type: "completed",
          content: [],
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
