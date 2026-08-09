import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { ModelStreamEvent } from "@harness/protocol";
import { toChatEvents } from "./stream.ts";

type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

// Test fixtures only carry the fields the translator reads, cast to the native type.
async function* emit(...events: unknown[]): AsyncIterable<ChatChunk> {
  for (const e of events) yield e as ChatChunk;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const never = new AbortController().signal;

const chunk = (delta: Record<string, unknown>, finish?: unknown): unknown => ({
  choices: [{ delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }],
});

const usageChunk = (usage: unknown): unknown => ({ choices: [], usage });

describe("toChatEvents", () => {
  it("emits reasoning before the following text and completes with usage", async () => {
    const stream = emit(
      chunk({ role: "assistant", reasoning_content: "think" }),
      chunk({ reasoning_content: " harder" }),
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      chunk({}, "stop"),
      usageChunk({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: {} }),
    );

    expect(await collect(toChatEvents(stream, "opencode-go", "deepseek-v4-pro", never))).toEqual([
      { type: "reasoning_delta", text: "think" },
      { type: "reasoning_delta", text: " harder" },
      { type: "reasoning", content: [{ type: "text", text: "think harder" }] },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      {
        type: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
      },
    ]);
  });

  it("surfaces cached prompt tokens as a subset of inputTokens", async () => {
    const stream = emit(
      usageChunk({
        prompt_tokens: 2000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 1536 },
      }),
    );
    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out[0]).toEqual({
      type: "completed",
      usage: { inputTokens: 2000, outputTokens: 50, cachedReadTokens: 1536 },
    });
  });

  it("emits reasoning + content deltas from the same chunk without dropping the content", async () => {
    const stream = emit(
      chunk({ role: "assistant", reasoning_content: "think now", content: "answer" }),
      chunk({}, "stop"),
      usageChunk({ prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: {} }),
    );

    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out).toEqual([
      { type: "reasoning_delta", text: "think now" },
      { type: "reasoning", content: [{ type: "text", text: "think now" }] },
      { type: "text_delta", text: "answer" },
      { type: "completed", usage: { inputTokens: 3, outputTokens: 2, cachedReadTokens: 0 } },
    ]);
  });

  it("completes the reasoning item at the boundary only once", async () => {
    // A single reasoning capture, followed by interleaved text that must not
    // reopen a finalized reasoning item or mask the text deltas.
    const stream = emit(
      chunk({ role: "assistant", reasoning_content: "think" }),
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      chunk({}, "stop"),
      usageChunk({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: {} }),
    );

    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out[0]).toEqual({ type: "reasoning_delta", text: "think" });
    expect(out[1]).toEqual({ type: "reasoning", content: [{ type: "text", text: "think" }] });
    expect(out.filter((e) => e.type === "reasoning")).toHaveLength(1);
    expect(out.slice(2, 4)).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
    ]);
  });

  it("emits reasoning before tool calls on a tool_calls finish, aggregating fragmented calls", async () => {
    const stream = emit(
      chunk({ role: "assistant", reasoning_content: "plan" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "echo", arguments: '{"x"' },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
      }),
      chunk({}, "tool_calls"),
      usageChunk({ prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: {} }),
    );

    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    // The finalized reasoning item must precede any tool_call from the same choice
    // so the engine log stays `[reasoning, tool_call]`.
    expect(out[0]).toEqual({ type: "reasoning_delta", text: "plan" });
    expect(out[1]).toEqual({ type: "reasoning", content: [{ type: "text", text: "plan" }] });
    const callIndex = out.findIndex((e) => e.type === "tool_call");
    expect(callIndex).toBeGreaterThan(1);
    expect(out[callIndex]).toEqual({
      type: "tool_call",
      callId: "call_1",
      name: "echo",
      args: { x: 1 },
    });
  });

  it("passes malformed tool arguments through as the raw string", async () => {
    const stream = emit(
      chunk({
        tool_calls: [
          { index: 0, id: "c", type: "function", function: { name: "f", arguments: "not json" } },
        ],
      }),
      chunk({}, "tool_calls"),
      usageChunk({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: {} }),
    );
    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out).toContainEqual({ type: "tool_call", callId: "c", name: "f", args: "not json" });
  });

  it("drops all tool calls on a length finish and completes with partial text", async () => {
    const stream = emit(
      chunk({ content: "partial" }),
      chunk({
        tool_calls: [
          { index: 0, id: "c", type: "function", function: { name: "f", arguments: "{" } },
        ],
      }),
      chunk({}, "length"),
      usageChunk({ prompt_tokens: 3, completion_tokens: 9, prompt_tokens_details: {} }),
    );

    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out).toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "completed",
        usage: { inputTokens: 3, outputTokens: 9, cachedReadTokens: 0 },
      },
    ]);
  });

  it("still completes with zeroed usage when the backend omits the usage tail", async () => {
    const stream = emit(chunk({ content: "hi" }), chunk({}, "stop"));
    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out[out.length - 1]).toEqual({
      type: "completed",
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
    });
  });

  it("persists a reasoning-only choice as a reasoning item before completed", async () => {
    const stream = emit(chunk({ reasoning_content: "only thinking" }), chunk({}, "stop"));
    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out).toEqual([
      { type: "reasoning_delta", text: "only thinking" },
      { type: "reasoning", content: [{ type: "text", text: "only thinking" }] },
      { type: "completed", usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } },
    ]);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = emit(
      chunk({ content: "x" }),
      usageChunk({ prompt_tokens: 1, completion_tokens: 1 }),
    );
    expect(await collect(toChatEvents(stream, "opencode-go", "m", ctrl.signal))).toEqual([]);
  });

  it("emits no completed when the stream dies without a terminal finish", async () => {
    // No `finish_reason` and no usage tail: the turn was cut off mid-flight, not
    // a usage-less completion. The engine turns a missing `completed` into an
    // error with no spend recorded, so the translator must not fabricate one.
    const stream = emit(chunk({ content: "partial" }));
    const out = await collect(toChatEvents(stream, "opencode-go", "m", never));
    expect(out).toEqual([{ type: "text_delta", text: "partial" }]);
  });
});
