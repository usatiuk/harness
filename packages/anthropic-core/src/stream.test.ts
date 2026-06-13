import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelStreamEvent } from "@harness/protocol";
import { toModelEvents } from "./stream.ts";

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

// Fixtures carry only the fields the translator reads, cast to the native event type.
async function* emit(...events: unknown[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e as StreamEvent;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const never = new AbortController().signal;

const start = (usage: Record<string, unknown>): unknown => ({
  type: "message_start",
  message: { usage },
});
const stop = (
  output_tokens: number,
  stop_reason = "end_turn",
  stop_details: unknown = null,
): unknown => ({
  type: "message_delta",
  delta: { stop_reason, stop_details },
  usage: { output_tokens },
});

describe("toModelEvents", () => {
  it("translates thinking (with signature payload), text, and tool calls in order", async () => {
    const stream = emit(
      start({ input_tokens: 10, output_tokens: 1 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me think" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "SIG123" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call_1", name: "echo", input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      },
      { type: "content_block_stop", index: 2 },
      stop(5, "tool_use"),
      { type: "message_stop" },
    );

    expect(await collect(toModelEvents(stream, "anthropic", "claude-x", never))).toEqual([
      { type: "reasoning_delta", text: "let me think" },
      {
        type: "reasoning",
        content: [{ type: "text", text: "let me think" }],
        payload: {
          provider: "anthropic",
          model: "claude-x",
          type: "thinking",
          version: 1,
          payload: { kind: "thinking", thinking: "let me think", signature: "SIG123" },
        },
      },
      { type: "text_delta", text: "Hello" },
      { type: "tool_call", callId: "call_1", name: "echo", args: { x: 1 } },
      {
        type: "completed",
        content: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
      },
    ]);
  });

  it("normalizes usage: input is the total of remainder + cache read + cache write", async () => {
    const stream = emit(
      start({
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 },
      }),
      stop(7),
      { type: "message_stop" },
    );
    const out = await collect(toModelEvents(stream, "anthropic", "m", never));
    expect(out.at(-1)).toEqual({
      type: "completed",
      content: [],
      usage: {
        inputTokens: 170,
        outputTokens: 7,
        cachedReadTokens: 50,
        cacheWriteTokens: { 300: 20 },
      },
    });
  });

  it("tags the thinking payload with the live provider/model", async () => {
    const stream = emit(
      start({ input_tokens: 0, output_tokens: 0 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "x", signature: "s" },
      },
      { type: "content_block_stop", index: 0 },
      stop(0),
      { type: "message_stop" },
    );
    const out = await collect(toModelEvents(stream, "anthropic-oauth", "claude-opus-4-8", never));
    expect(out[0]).toMatchObject({
      payload: { provider: "anthropic-oauth", model: "claude-opus-4-8" },
    });
  });

  it("emits a redacted thinking block as reasoning with empty canonical content", async () => {
    const stream = emit(
      start({ input_tokens: 0, output_tokens: 0 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "ENC" },
      },
      { type: "content_block_stop", index: 0 },
      stop(0),
      { type: "message_stop" },
    );
    const out = await collect(toModelEvents(stream, "anthropic", "m", never));
    expect(out[0]).toEqual({
      type: "reasoning",
      content: [],
      payload: {
        provider: "anthropic",
        model: "m",
        type: "thinking",
        version: 1,
        payload: { kind: "redacted", data: "ENC" },
      },
    });
  });

  it("tolerates an empty tool input buffer as an empty object", async () => {
    const stream = emit(
      start({ input_tokens: 0, output_tokens: 0 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "c", name: "f", input: {} },
      },
      { type: "content_block_stop", index: 0 },
      stop(0),
      { type: "message_stop" },
    );
    const out = await collect(toModelEvents(stream, "anthropic", "m", never));
    expect(out[0]).toEqual({ type: "tool_call", callId: "c", name: "f", args: {} });
  });

  it("throws on a refusal stop reason, carrying the category", async () => {
    const stream = emit(
      start({ input_tokens: 0, output_tokens: 0 }),
      stop(0, "refusal", { type: "refusal", category: "cyber" }),
      { type: "message_stop" },
    );
    await expect(collect(toModelEvents(stream, "anthropic", "m", never))).rejects.toThrow(/cyber/);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = emit(start({ input_tokens: 1, output_tokens: 1 }));
    expect(await collect(toModelEvents(stream, "anthropic", "m", ctrl.signal))).toEqual([]);
  });
});
