import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelOutputItem, ModelStreamEvent, Usage } from "@harness/protocol";
import { jsonValueSchema } from "@harness/protocol";
import {
  encodeThinkingPayload,
  encodeBlockPayload,
  completedSearchFilter,
  type ThinkingPayload,
} from "./payload.ts";

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/** Cache-write TTL seconds, keyed to match `Usage.cacheWriteTokens` (Anthropic 5m/1h). */
const TTL_5M = 300;
const TTL_1H = 3600;

/** A content block being assembled across `content_block_start` → deltas → `content_block_stop`. */
type Block =
  | { kind: "text"; native: Anthropic.Messages.TextBlock }
  | { kind: "native"; native: Anthropic.Messages.ContentBlock; json: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool_use"; native: Anthropic.Messages.ToolUseBlock; json: string };

/**
 * Anthropic `input_tokens` is the *uncached remainder*; the harness `Usage.inputTokens` is the
 * TOTAL. Reconstruct the total from the three disjoint input counts and report the cache split.
 */
function normalizeInputUsage(usage: Anthropic.Messages.Usage): Usage {
  const cachedRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  let write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Our request builder uses the default 5m TTL. Search may increase the cumulative
  // aggregate without updating the initial breakdown. A reported 1h split cannot
  // be extrapolated; preserve only its known allocation and mark cost incomplete.
  if (write1h === 0) write5m = cacheCreation;
  const cacheWriteTokens: Record<number, number> = {};
  if (write5m + write1h <= cacheCreation) {
    if (write5m) cacheWriteTokens[TTL_5M] = write5m;
    if (write1h) cacheWriteTokens[TTL_1H] = write1h;
  }
  return {
    inputTokens: usage.input_tokens + cachedRead + cacheCreation,
    outputTokens: usage.output_tokens,
    cachedReadTokens: cachedRead,
    ...(Object.keys(cacheWriteTokens).length ? { cacheWriteTokens } : {}),
  };
}

/** Empty input is an object; malformed JSON remains readable for tool validation. */
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
): Extract<ModelOutputItem, { type: "reasoning" }> {
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
 * message/tool-call items. Terminal errors retain usage before the engine fails the turn.
 */
export async function* toModelEvents(
  stream: AsyncIterable<StreamEvent>,
  provider: string,
  model: string,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const blocks = new Map<number, Block>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };
  let error: string | undefined;
  let searched = false;
  let providerUsage: Anthropic.Messages.Usage | undefined;
  let outputReported = false;
  const deferred: Exclude<ModelOutputItem, { type: "provider_output" }>[] = [];
  let pending: Anthropic.Messages.ContentBlock[] = [];
  let finalized = false;

  const completed = (complete: boolean): Extract<ModelStreamEvent, { type: "completed" }> => {
    const written = Object.values(usage.cacheWriteTokens ?? {}).reduce((a, b) => a + b, 0);
    const costIncomplete =
      searched || written !== (providerUsage?.cache_creation_input_tokens ?? 0);
    return {
      type: "completed",
      usage: complete || outputReported ? usage : null,
      ...(searched ? { inputTokensAreContext: false } : {}),
      ...(costIncomplete ? { costIncomplete: true } : {}),
      ...(costIncomplete && providerUsage
        ? { providerUsage: jsonValueSchema.parse(providerUsage) }
        : {}),
      ...(error || !complete
        ? { error: error ?? "anthropic stream ended before message_stop" }
        : {}),
    };
  };

  // After search starts, finalize native metadata only at message_stop. This
  // keeps pause_turn/incomplete search state out of later conversation requests.
  const finish = (
    item: Exclude<ModelOutputItem, { type: "provider_output" }>,
    native: Anthropic.Messages.ContentBlock,
  ): ModelStreamEvent[] => {
    if (!searched) return [item];
    item.payload = encodeBlockPayload([...pending, native], provider, model);
    pending = [];
    deferred.push(item);
    return [];
  };

  try {
    for await (const event of stream) {
      if (signal.aborted) break;
      switch (event.type) {
        case "message_start":
          usage = normalizeInputUsage(event.message.usage);
          providerUsage = { ...event.message.usage };
          break;
        case "content_block_start": {
          const cb = event.content_block;
          searched ||= cb.type === "server_tool_use";
          if (cb.type === "thinking") {
            // Thinking text and signature arrive via deltas; the start event's fields are empty.
            blocks.set(event.index, { kind: "thinking", thinking: "", signature: "" });
          } else if (cb.type === "redacted_thinking") {
            blocks.set(event.index, { kind: "redacted", data: cb.data });
          } else if (cb.type === "tool_use") {
            blocks.set(event.index, { kind: "tool_use", native: structuredClone(cb), json: "" });
          } else if (cb.type === "text") {
            blocks.set(event.index, { kind: "text", native: structuredClone(cb) });
            if (cb.text && (!searched || deferred.length === 0))
              yield { type: "text_delta", text: cb.text };
          } else if (cb.type === "server_tool_use" || cb.type === "web_search_tool_result") {
            blocks.set(event.index, { kind: "native", native: structuredClone(cb), json: "" });
          } else throw new Error(`anthropic returned unsupported output block: ${cb.type}`);
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          const block = blocks.get(event.index);
          if (delta.type === "text_delta") {
            if (block?.kind !== "text")
              throw new Error("anthropic text delta without a text block");
            block.native.text += delta.text;
            if (!searched || deferred.length === 0) yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "thinking_delta") {
            if (block?.kind === "thinking") block.thinking += delta.thinking;
            if (!searched || deferred.length === 0)
              yield { type: "reasoning_delta", text: delta.thinking };
          } else if (delta.type === "signature_delta") {
            if (block?.kind === "thinking") block.signature += delta.signature;
          } else if (delta.type === "input_json_delta") {
            if (block?.kind === "tool_use") block.json += delta.partial_json;
            else if (block?.kind === "native") block.json += delta.partial_json;
          } else if (delta.type === "citations_delta" && block?.kind === "text") {
            (block.native.citations ??= []).push(delta.citation);
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(event.index);
          if (!block) break;
          blocks.delete(event.index);
          if (block.kind === "thinking" || block.kind === "redacted") {
            const reasoning = reasoningEvent(block, provider, model);
            yield* finish(
              reasoning,
              block.kind === "thinking"
                ? { type: "thinking", thinking: block.thinking, signature: block.signature }
                : { type: "redacted_thinking", data: block.data },
            );
          } else if (block.kind === "text") {
            yield* finish(
              {
                type: "message",
                content: [{ type: "text", text: block.native.text }],
                payload: encodeBlockPayload([block.native], provider, model),
              },
              block.native,
            );
          } else if (block.kind === "native") {
            if (block.native.type === "server_tool_use" && block.json)
              block.native.input = parseToolInput(block.json);
            pending.push(block.native);
            let text = "Search completed.";
            if (block.native.type === "server_tool_use") text = "Searching the web…";
            else if (block.native.type === "web_search_tool_result")
              text = Array.isArray(block.native.content)
                ? block.native.content.length
                  ? "Search completed."
                  : "Search returned no results."
                : "Search failed.";
            yield { type: "provider_output", content: [{ type: "text", text }] };
          } else if (block.kind === "tool_use") {
            const args = block.json ? parseToolInput(block.json) : block.native.input;
            block.native.input = args;
            yield* finish(
              {
                type: "tool_call",
                callId: block.native.id,
                name: block.native.name,
                args,
              },
              block.native,
            );
          }
          break;
        }
        case "message_delta": {
          if (!providerUsage) throw new Error("anthropic usage delta without message_start");
          outputReported = true;
          providerUsage = {
            ...providerUsage,
            ...Object.fromEntries(
              Object.entries(event.usage).filter(
                ([, value]) => value !== null && value !== undefined,
              ),
            ),
          };
          usage = normalizeInputUsage(providerUsage);
          if (event.delta.stop_reason === "pause_turn")
            error = "anthropic search did not complete in this request";
          if (event.delta.stop_reason === "refusal") {
            const category = event.delta.stop_details?.category ?? "unspecified";
            error = `anthropic refused the request (category: ${category})`;
          }
          if (event.delta.stop_reason === "max_tokens")
            error = "anthropic output truncated at the model limit";
          break;
        }
        case "message_stop": {
          if (!providerUsage) throw new Error("anthropic message_stop without message_start");
          finalized = true;
          const last = deferred.at(-1);
          if (last?.payload && pending.length)
            last.payload = encodeBlockPayload(
              [...(last.payload.payload as Anthropic.Messages.ContentBlock[]), ...pending],
              provider,
              model,
            );
          else if (!error && pending.length)
            deferred.push({
              type: "message",
              content: [],
              payload: encodeBlockPayload(pending, provider, model),
            });
          const keepSearch = completedSearchFilter(
            deferred.flatMap(
              (item) => (item.payload?.payload as Anthropic.Messages.ContentBlock[]) ?? [],
            ),
          );
          for (const item of deferred) {
            if (error) delete item.payload;
            else if (item.payload)
              item.payload = encodeBlockPayload(
                (item.payload.payload as Anthropic.Messages.ContentBlock[]).filter(keepSearch),
                provider,
                model,
              );
          }
          yield* deferred;
          yield completed(true);
          return;
        }
        default:
          break;
      }
    }
  } finally {
    if (!finalized) {
      for (const item of deferred) delete item.payload;
      yield* deferred;
      // Open readable blocks have no valid signature/native bundle yet. Drain
      // their received text too, including suffixes whose preview was deferred.
      for (const block of blocks.values()) {
        if (block.kind === "text" && block.native.text)
          yield { type: "message", content: [{ type: "text", text: block.native.text }] };
        else if (block.kind === "thinking" && block.thinking)
          yield { type: "reasoning", content: [{ type: "text", text: block.thinking }] };
      }
      if (providerUsage) yield completed(false);
    }
  }
}
