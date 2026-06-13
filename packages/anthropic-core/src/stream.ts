import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelStreamEvent, Usage } from "@harness/protocol";
import { encodeThinkingPayload, type ThinkingPayload } from "./payload.ts";

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/** Cache-write TTL seconds, keyed to match `Usage.cacheWriteTokens` (Anthropic 5m/1h). */
const TTL_5M = 300;
const TTL_1H = 3600;

/** A content block being assembled across `content_block_start` → deltas → `content_block_stop`. */
type Block =
  | { kind: "text" }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool_use"; id: string; name: string; json: string };

/**
 * Anthropic `input_tokens` is the *uncached remainder*; the harness `Usage.inputTokens` is the
 * TOTAL. Reconstruct the total from the three disjoint input counts and report the cache split.
 */
function normalizeInputUsage(usage: Anthropic.Messages.Usage): Usage {
  const cachedRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cacheWriteTokens: Record<number, number> = {};
  if (write5m) cacheWriteTokens[TTL_5M] = write5m;
  if (write1h) cacheWriteTokens[TTL_1H] = write1h;
  return {
    inputTokens: usage.input_tokens + cachedRead + cacheCreation,
    // `message_start` carries only a placeholder output count; the real total lands on `message_delta`.
    outputTokens: 0,
    cachedReadTokens: cachedRead,
    ...(write5m || write1h ? { cacheWriteTokens } : {}),
  };
}

/** Tolerate an empty or malformed tool JSON buffer by falling back to an empty object. */
function parseToolInput(json: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** A finalized thinking/redacted block → its `reasoning` event (canonical content is display-only). */
function reasoningEvent(
  block: Extract<Block, { kind: "thinking" | "redacted" }>,
  provider: string,
  model: string,
): ModelStreamEvent {
  const payload: ThinkingPayload =
    block.kind === "thinking"
      ? { kind: "thinking", thinking: block.thinking, signature: block.signature }
      : { kind: "redacted", data: block.data };
  const content: ContentBlock[] =
    block.kind === "thinking" ? [{ type: "text", text: block.thinking }] : [];
  return { type: "reasoning", content, payload: encodeThinkingPayload(payload, provider, model) };
}

/**
 * Translates Anthropic's Messages stream into provider-agnostic `ModelStreamEvent`s. Text and
 * thinking deltas drive live display; `content_block_stop` carries the authoritative reasoning /
 * tool-call items. A `refusal` stop reason throws so the engine surfaces it as a turn error.
 */
export async function* toModelEvents(
  stream: AsyncIterable<StreamEvent>,
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const blocks = new Map<number, Block>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };

  for await (const event of stream) {
    if (signal.aborted) return;
    switch (event.type) {
      case "message_start":
        usage = normalizeInputUsage(event.message.usage);
        break;
      case "content_block_start": {
        const cb = event.content_block;
        if (cb.type === "thinking") {
          // Thinking text and signature arrive via deltas; the start event's fields are empty.
          blocks.set(event.index, { kind: "thinking", thinking: "", signature: "" });
        } else if (cb.type === "redacted_thinking") {
          blocks.set(event.index, { kind: "redacted", data: cb.data });
        } else if (cb.type === "tool_use") {
          blocks.set(event.index, { kind: "tool_use", id: cb.id, name: cb.name, json: "" });
        } else {
          blocks.set(event.index, { kind: "text" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        const block = blocks.get(event.index);
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "thinking_delta") {
          if (block?.kind === "thinking") block.thinking += delta.thinking;
          yield { type: "reasoning_delta", text: delta.thinking };
        } else if (delta.type === "signature_delta") {
          if (block?.kind === "thinking") block.signature += delta.signature;
        } else if (delta.type === "input_json_delta") {
          if (block?.kind === "tool_use") block.json += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (!block) break;
        blocks.delete(event.index);
        if (block.kind === "thinking" || block.kind === "redacted") {
          yield reasoningEvent(block, provider, model);
        } else if (block.kind === "tool_use") {
          yield {
            type: "tool_call",
            callId: block.id,
            name: block.name,
            args: parseToolInput(block.json),
          };
        }
        break;
      }
      case "message_delta": {
        usage = { ...usage, outputTokens: event.usage.output_tokens };
        if (event.delta.stop_reason === "refusal") {
          const category = event.delta.stop_details?.category ?? "unspecified";
          throw new Error(`anthropic refused the request (category: ${category})`);
        }
        break;
      }
      case "message_stop":
        // Canonical text is reconstructed from the streamed deltas, so content is empty.
        yield { type: "completed", content: [], usage };
        break;
      default:
        break;
    }
  }
}
