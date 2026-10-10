import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Item, ModelRequest, ModelStreamEvent, ProviderPayload } from "@harness/protocol";
import { toModelEvents } from "./stream.ts";
import { buildMessages } from "./request.ts";

describe("finalized native search history", () => {
  it.each([
    ["abort", false],
    ["abort", true],
    ["transport error", false],
    ["transport error", true],
    ["end", false],
    ["end", true],
  ] as const)(
    "drains received content on %s before message_stop (reported usage: %s)",
    async (outcome, reported) => {
      const controller = new AbortController();
      const received: ModelStreamEvent[] = [];
      async function* source() {
        yield* emit(
          start({ input_tokens: 10, output_tokens: 0 }),
          ...[
            { type: "server_tool_use", id: "search", name: "web_search", input: {} },
            { type: "text", text: "A" },
            { type: "text", text: "B" },
          ].flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
          ]),
          { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Partial" } },
        );
        if (reported) yield* emit(stop(7));
        if (outcome === "transport error") throw new Error("transport dropped");
        if (outcome === "abort") {
          controller.abort();
          yield { type: "ping" } as unknown as StreamEvent;
        }
      }
      const collectReceived = async () => {
        for await (const event of toModelEvents(source(), "anthropic", "m", controller.signal))
          received.push(event);
      };
      if (outcome === "transport error")
        await expect(collectReceived()).rejects.toThrow("transport dropped");
      else await collectReceived();
      expect(received.filter((event) => event.type === "message")).toEqual([
        { type: "message", content: [{ type: "text", text: "A" }] },
        { type: "message", content: [{ type: "text", text: "B" }] },
        { type: "message", content: [{ type: "text", text: "Partial" }] },
      ]);
      expect(
        received
          .filter((event) => event.type === "message")
          .every((event) => !("payload" in event)),
      ).toBe(true);
      expect(received.at(-1)).toMatchObject({
        type: "completed",
        usage: reported ? { inputTokens: 10, outputTokens: 7 } : null,
        costIncomplete: true,
        inputTokensAreContext: false,
        error: "anthropic stream ended before message_stop",
      });
    },
  );
  it("drains an open thinking suffix without its incomplete signature", async () => {
    const out = await collect(
      toModelEvents(
        emit(
          start({ input_tokens: 10, output_tokens: 0 }),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Partial thought" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "Partial signature" },
          },
        ),
        "anthropic",
        "m",
        never,
      ),
    );
    expect(out).toEqual([
      { type: "reasoning_delta", text: "Partial thought" },
      { type: "reasoning", content: [{ type: "text", text: "Partial thought" }] },
      { type: "completed", usage: null, error: "anthropic stream ended before message_stop" },
    ]);
  });
  it.each([0, 20])(
    "uses cumulative default-TTL cache writes (initial count: %s)",
    async (initial) => {
      const out = await collect(
        toModelEvents(
          emit(
            start({
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: initial,
              cache_creation: { ephemeral_5m_input_tokens: initial, ephemeral_1h_input_tokens: 0 },
            }),
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { cache_creation_input_tokens: 100, output_tokens: 7 },
            },
            { type: "message_stop" },
          ),
          "anthropic",
          "m",
          never,
        ),
      );
      expect(out.at(-1)).toEqual({
        type: "completed",
        usage: {
          inputTokens: 110,
          outputTokens: 7,
          cachedReadTokens: 0,
          cacheWriteTokens: { 300: 100 },
        },
      });
    },
  );
  it("marks an updated aggregate with an unknown mixed-TTL allocation as incomplete", async () => {
    const out = await collect(
      toModelEvents(
        emit(
          start({
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: 20,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 },
          }),
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { cache_creation_input_tokens: 100, output_tokens: 7 },
          },
          { type: "message_stop" },
        ),
        "anthropic",
        "m",
        never,
      ),
    );
    expect(out.at(-1)).toMatchObject({
      type: "completed",
      usage: { inputTokens: 110, outputTokens: 7, cacheWriteTokens: { 300: 10, 3600: 10 } },
      costIncomplete: true,
      providerUsage: { cache_creation_input_tokens: 100 },
    });
  });
  it("normalizes cumulative input and cache counts reported after a search", async () => {
    const out = await collect(
      toModelEvents(
        emit(
          start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2 }),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id: "search", name: "web_search", input: {} },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 50, cache_read_input_tokens: 8, output_tokens: 5 },
          },
          { type: "message_stop" },
        ),
        "anthropic",
        "m",
        never,
      ),
    );
    expect(out.at(-1)).toMatchObject({
      usage: { inputTokens: 58, outputTokens: 5, cachedReadTokens: 8 },
      providerUsage: { input_tokens: 50, cache_read_input_tokens: 8 },
    });
  });
  const blocks = [
    { type: "server_tool_use", id: "search", name: "web_search", input: { query: "example" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "search",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com",
          title: "Example",
          encrypted_content: "ENCRYPTED",
          page_age: null,
        },
      ],
    },
    {
      type: "text",
      text: "[Source](https://example.com)",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://example.com",
          title: "Example",
          encrypted_index: "INDEX",
          cited_text: "example",
        },
      ],
    },
  ];
  const nativeEvents = (native: object[], reason = "end_turn") =>
    emit(
      start({ input_tokens: 10, output_tokens: 0 }),
      ...native.flatMap((content_block, index) => [
        { type: "content_block_start", index, content_block },
        { type: "content_block_stop", index },
      ]),
      stop(5, reason),
      { type: "message_stop" },
    );
  const request = (events: ModelStreamEvent[]): ModelRequest => ({
    instructions: [],
    modelConfig: { provider: "anthropic", model: "m" },
    items: events.flatMap((event) =>
      event.type === "message" ||
      event.type === "tool_call" ||
      event.type === "reasoning" ||
      event.type === "provider_output"
        ? [
            {
              item: {
                id: "i",
                conversationId: "c",
                turnId: "t",
                seq: 0,
                parent: null,
                createdAt: 0,
                ...event,
                ...(event.type === "message" ? { role: "assistant" } : {}),
              } as Item,
              ...(event.payload
                ? { payload: { ...event.payload, itemId: "i" as ProviderPayload["itemId"] } }
                : {}),
            },
          ]
        : [],
    ),
  });

  it("round-trips completed search blocks and citations while keeping hints display-only", async () => {
    const out = await collect(toModelEvents(nativeEvents(blocks), "anthropic", "m", never));
    const messages = buildMessages(request(out), { maxTokens: 100 }, "anthropic").messages;
    expect(messages).toMatchObject([{ role: "assistant", content: blocks }]);
    expect(
      out
        .filter((event) => event.type === "provider_output")
        .every((event) => !("payload" in event)),
    ).toBe(true);
    expect(out.find((event) => event.type === "message")).toMatchObject({
      content: [{ type: "text", text: "[Source](https://example.com)" }],
    });
    expect(JSON.stringify(messages)).not.toContain("Search completed.");
    expect(out.at(-1)).toMatchObject({ type: "completed", costIncomplete: true });
  });
  it("keeps completed search history across readable output and removes unmatched selected prefixes", async () => {
    const native = [blocks[0]!, { type: "text", text: "Searching" }, blocks[1]!, blocks[2]!];
    const out = await collect(toModelEvents(nativeEvents(native), "anthropic", "m", never));
    const draft = request(out);
    expect(buildMessages(draft, { maxTokens: 100 }, "anthropic").messages).toMatchObject([
      { role: "assistant", content: native },
    ]);
    const first = draft.items.findIndex(({ item }) => item.type === "message");
    expect(
      buildMessages(
        { ...draft, items: draft.items.slice(0, first + 1) },
        { maxTokens: 100 },
        "anthropic",
      ).messages,
    ).toMatchObject([{ role: "assistant", content: [{ type: "text", text: "Searching" }] }]);
  });

  it("drops pending server calls while preserving the existing local-tool loop", async () => {
    const local = { type: "tool_use", id: "local", name: "echo", input: {} };
    const out = await collect(
      toModelEvents(nativeEvents([blocks[0]!, local], "tool_use"), "anthropic", "m", never),
    );
    expect(out.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(out.at(-1)).not.toHaveProperty("error");
    const draft = request(out);
    draft.items.push({
      item: {
        id: "result",
        conversationId: "c",
        turnId: "t",
        seq: 1,
        parent: null,
        createdAt: 0,
        type: "tool_result",
        callId: "local",
        status: "ok",
        content: [{ type: "text", text: "echoed" }],
      } as Item,
    });
    draft.items.push({
      item: {
        id: "context",
        conversationId: "c",
        turnId: "t",
        seq: 2,
        parent: null,
        createdAt: 0,
        type: "context",
        content: [{ type: "text", text: "Tool context" }],
        key: "tool",
      } as Item,
    });
    draft.toolChoice = "none";
    expect(buildMessages(draft, { maxTokens: 100 }, "anthropic").messages).toMatchObject([
      { role: "assistant", content: [local] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "local", content: "echoed" },
          { type: "text", text: "Tool context" },
        ],
      },
    ]);
    expect(JSON.stringify(buildMessages(draft, { maxTokens: 100 }, "anthropic"))).not.toContain(
      "server_tool_use",
    );
  });
  it("retains completed search history when a local call needs a raw-text fallback", async () => {
    const local = { type: "tool_use", id: "local", name: "echo", input: "{" };
    const out = await collect(
      toModelEvents(
        nativeEvents([blocks[0]!, blocks[1]!, local], "tool_use"),
        "anthropic",
        "m",
        never,
      ),
    );
    const draft = request(out);
    draft.items.push({
      item: {
        id: "result",
        conversationId: "c",
        turnId: "t",
        seq: 1,
        parent: null,
        createdAt: 0,
        type: "tool_result",
        callId: "local",
        status: "error",
        content: [{ type: "text", text: "invalid arguments" }],
      } as Item,
    });
    expect(buildMessages(draft, { maxTokens: 100 }, "anthropic").messages).toMatchObject([
      {
        role: "assistant",
        content: [blocks[0], blocks[1], { type: "text", text: "Tool echo: {" }],
      },
      { role: "user", content: [{ type: "text", text: "invalid arguments" }] },
    ]);
  });

  it("does not retain paused search state and preserves its readable preview", async () => {
    const out = await collect(
      toModelEvents(nativeEvents([blocks[0]!, blocks[2]!], "pause_turn"), "anthropic", "m", never),
    );
    expect(out.some((event) => event.type === "text_delta")).toBe(true);
    expect(
      out.filter((event) => event.type === "message").every((event) => !("payload" in event)),
    ).toBe(true);
    expect(
      JSON.stringify(buildMessages(request(out), { maxTokens: 100 }, "anthropic")),
    ).not.toContain("server_tool_use");
    expect(out.at(-1)).toMatchObject({
      type: "completed",
      error: "anthropic search did not complete in this request",
    });
  });
});

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
  it("finishes at message_stop without reading a failed transport tail", async () => {
    async function* source() {
      yield* emit(start({ input_tokens: 10, output_tokens: 0 }), stop(7), { type: "message_stop" });
      throw new Error("transport tail failed");
    }
    expect(await collect(toModelEvents(source(), "anthropic", "m", never))).toEqual([
      { type: "completed", usage: { inputTokens: 10, outputTokens: 7, cachedReadTokens: 0 } },
    ]);
  });
  it("emits a payload-free search hint and fails an unfinished request without continuation", async () => {
    const out = await collect(
      toModelEvents(
        emit(
          start({ input_tokens: 10, output_tokens: 0 }),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id: "search", name: "web_search", input: {} },
          },
          { type: "content_block_stop", index: 0 },
          stop(5, "pause_turn"),
          { type: "message_stop" },
        ),
        "anthropic",
        "claude-x",
        never,
      ),
    );
    expect(out[0]).toEqual({
      type: "provider_output",
      content: [{ type: "text", text: "Searching the web…" }],
    });
    expect(out[1]).toMatchObject({
      type: "completed",
      error: "anthropic search did not complete in this request",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(out[1]).not.toHaveProperty("requiresContinuation");
  });

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
      {
        type: "message",
        content: [{ type: "text", text: "Hello" }],
        payload: {
          provider: "anthropic",
          model: "claude-x",
          type: "message_blocks",
          version: 1,
          payload: [{ type: "text", text: "Hello" }],
        },
      },
      { type: "tool_call", callId: "call_1", name: "echo", args: { x: 1 } },
      {
        type: "completed",
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

  it("reports refusal with usage and its category", async () => {
    const stream = emit(
      start({ input_tokens: 0, output_tokens: 0 }),
      stop(0, "refusal", { type: "refusal", category: "cyber" }),
      { type: "message_stop" },
    );
    expect(await collect(toModelEvents(stream, "anthropic", "m", never))).toEqual([
      {
        type: "completed",
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
        error: "anthropic refused the request (category: cyber)",
      },
    ]);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = emit(start({ input_tokens: 1, output_tokens: 1 }));
    expect(await collect(toModelEvents(stream, "anthropic", "m", ctrl.signal))).toEqual([]);
  });
});
