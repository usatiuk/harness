import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { ModelStreamEvent } from "@harness/protocol";
import { toModelEvents } from "./stream.ts";

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

// Test fixtures only carry the fields the translator reads, cast to the native type.
async function* emit(...events: unknown[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e as StreamEvent;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const never = new AbortController().signal;

describe("toModelEvents", () => {
  it("translates reasoning (with payload), text, and tool calls in emission order", async () => {
    const stream = emit(
      { type: "response.reasoning_summary_text.delta", delta: "think" },
      {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "thought it through" }],
          encrypted_content: "BLOB",
        },
      },
      { type: "response.output_text.delta", delta: "Hello" },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"x":1}' },
      },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    );

    expect(await collect(toModelEvents(stream, "openai", "gpt-test", never))).toEqual([
      { type: "reasoning_delta", text: "think" },
      {
        type: "reasoning",
        content: [{ type: "text", text: "thought it through" }],
        payload: {
          provider: "openai",
          model: "gpt-test",
          type: "reasoning",
          version: 1,
          payload: { id: "rs_1", encryptedContent: "BLOB" },
        },
      },
      { type: "text_delta", text: "Hello" },
      { type: "tool_call", callId: "call_1", name: "echo", args: { x: 1 } },
      {
        type: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
      },
    ]);
  });

  it("surfaces cached prompt tokens as a subset of inputTokens", async () => {
    const stream = emit({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 2000,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 1536 },
        },
      },
    });
    const out = await collect(toModelEvents(stream, "openai", "m", never));
    expect(out[0]).toEqual({
      type: "completed",
      usage: { inputTokens: 2000, outputTokens: 50, cachedReadTokens: 1536 },
    });
  });

  it("tags the reasoning payload with the live provider id", async () => {
    const stream = emit(
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_3", summary: [], encrypted_content: "BLOB" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    );
    const out = await collect(toModelEvents(stream, "openai-codex", "gpt-5.5", never));
    expect(out[0]).toMatchObject({ payload: { provider: "openai-codex", model: "gpt-5.5" } });
  });

  it("omits the payload when reasoning has no encrypted_content", async () => {
    const stream = emit(
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "s" }] },
      },
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    );
    const out = await collect(toModelEvents(stream, "openai", "m", never));
    expect(out[0]).toEqual({ type: "reasoning", content: [{ type: "text", text: "s" }] });
  });

  it("passes malformed tool arguments through as the raw string", async () => {
    const stream = emit(
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c", name: "f", arguments: "not json" },
      },
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    );
    const out = await collect(toModelEvents(stream, "openai", "m", never));
    expect(out[0]).toEqual({ type: "tool_call", callId: "c", name: "f", args: "not json" });
  });

  it("maps a custom_tool_call to a tool_call carrying the raw input string", async () => {
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n";
    const stream = emit(
      {
        type: "response.output_item.done",
        item: { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: patch },
      },
      { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } },
    );
    const out = await collect(toModelEvents(stream, "openai", "m", never));
    expect(out[0]).toEqual({
      type: "tool_call",
      callId: "call_p",
      name: "apply_patch",
      args: patch,
    });
  });

  it("throws on a failed response", async () => {
    const stream = emit({ type: "response.failed", response: { error: { message: "boom" } } });
    await expect(collect(toModelEvents(stream, "openai", "m", never))).rejects.toThrow(/boom/);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = emit({ type: "response.output_text.delta", delta: "x" });
    expect(await collect(toModelEvents(stream, "openai", "m", ctrl.signal))).toEqual([]);
  });
});
