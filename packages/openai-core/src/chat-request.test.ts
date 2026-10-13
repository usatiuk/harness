import { describe, expect, it } from "vitest";
import type { Item, ModelRequest } from "@harness/protocol";
import { buildChatParams } from "./request.ts";

// Items only need their structural fields here; ids/seq/createdAt are irrelevant to mapping.
const item = (partial: Partial<Item> & { type: Item["type"] }): Item =>
  ({ id: "i", conversationId: "c", turnId: "t", seq: 0, createdAt: 0, ...partial }) as Item;

const baseRequest = (items: ModelRequest["items"]): ModelRequest => ({
  instructions: [{ type: "text", text: "be nice" }],
  modelConfig: { provider: "opencode-go", model: "deepseek-v4-pro" },
  tools: [
    { kind: "function", name: "echo", description: "echoes", parameters: { type: "object" } },
  ],
  // These fixtures represent reasoning captured from this exact chat connection.
  items: items.map((entry) =>
    entry.item.type === "reasoning" && entry.payload === undefined
      ? {
          ...entry,
          payload: {
            itemId: entry.item.id,
            provider: "opencode-go",
            model: "deepseek-v4-pro",
            type: "chat_reasoning",
            version: 1,
            payload: null,
          },
        }
      : entry,
  ),
});

describe("buildChatParams", () => {
  it("does not treat a fork-owned JSON call as an inherited raw call with the same ID", () => {
    const entries = ["source", "fork"].flatMap((owner) => [
      {
        item: item({
          type: "tool_call",
          conversationId: owner as Item["conversationId"],
          callId: "same",
          name: "echo",
          args: owner === "source" ? "raw" : { text: "new" },
        }),
      },
      {
        item: item({
          type: "tool_result",
          conversationId: owner as Item["conversationId"],
          callId: "same",
          status: "ok",
          content: [{ type: "text", text: owner }],
        }),
      },
    ]);
    const messages = buildChatParams(baseRequest(entries)).messages;
    expect(messages[2]).toEqual({ role: "user", content: "source" });
    expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: "same", content: "fork" });
    expect(messages[3]).toMatchObject({
      tool_calls: [{ id: "same", function: { arguments: '{"text":"new"}' } }],
    });
  });
  it("omits foreign or unbound reasoning and renders raw-string historical calls as text", () => {
    const params = buildChatParams({
      ...baseRequest([]),
      items: [
        { item: item({ type: "reasoning", content: [{ type: "text", text: "unbound" }] }) },
        {
          item: item({ type: "reasoning", content: [{ type: "text", text: "foreign" }] }),
          payload: {
            itemId: "i" as Item["id"],
            provider: "other",
            model: "other",
            type: "chat_reasoning",
            version: 1,
            payload: null,
          },
        },
        { item: item({ type: "tool_call", callId: "patch", name: "apply_patch", args: "PATCH" }) },
        {
          item: item({
            type: "tool_result",
            callId: "patch",
            status: "ok",
            content: [{ type: "text", text: "applied" }],
          }),
        },
      ],
    });
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "assistant", content: "Tool apply_patch: PATCH" },
      { role: "user", content: "applied" },
    ]);
  });

  it("maps instructions to a single leading system message and items to native messages", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) },
        { item: item({ type: "tool_call", callId: "call_1", name: "echo", args: { x: 1 } }) },
        {
          item: item({
            type: "tool_result",
            callId: "call_1",
            content: [{ type: "text", text: "ok" }],
            status: "ok",
          }),
        },
      ]),
    );

    expect(params.model).toBe("deepseek-v4-pro");
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "echo", arguments: '{"x":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
    expect(params.tools).toEqual([
      {
        type: "function",
        function: { name: "echo", description: "echoes", parameters: { type: "object" } },
      },
    ]);
  });

  it("appends a non-durable prompt and honors toolChoice and maxOutputTokens", () => {
    const params = buildChatParams({
      ...baseRequest([]),
      prompt: "compact now",
      toolChoice: "none",
      maxOutputTokens: 4096,
    });
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "compact now" },
    ]);
    expect(params.tool_choice).toBe("none");
    expect(params.max_tokens).toBe(4096);
  });

  it("merges a reasoning item into the assistant message that follows it", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({
            type: "reasoning",
            content: [{ type: "text", text: "thought it through" }],
          }),
        },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "done",
        reasoning_content: "thought it through",
      },
    ]);
  });

  it("merges a reasoning item into the following tool_call assistant message", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }),
        },
        { item: item({ type: "tool_call", callId: "c", name: "echo", args: {} }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "plan",
        tool_calls: [{ id: "c", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
    ]);
  });

  it("emits a standalone reasoning message when nothing follows", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({ type: "reasoning", content: [{ type: "text", text: "thinking only" }] }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "assistant", content: null, reasoning_content: "thinking only" },
    ]);
  });

  it("hoists context items into the leading system message joined by blank lines", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({
            type: "context",
            key: "agents",
            content: [{ type: "text", text: "project rules" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([{ role: "system", content: "be nice\n\nproject rules" }]);
  });

  it("maps a compaction item to a plain user message", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({ type: "compaction", content: [{ type: "text", text: "the story so far" }] }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "the story so far" },
    ]);
  });

  it("throws on a custom (freeform) tool", () => {
    const request: ModelRequest = {
      ...baseRequest([]),
      tools: [{ kind: "custom", name: "apply_patch", description: "patch" }],
    };
    expect(() => buildChatParams(request)).toThrow(/function-only/);
  });

  it("throws on a system-role message item", () => {
    const request = baseRequest([
      { item: item({ type: "message", role: "system", content: [{ type: "text", text: "x" }] }) },
    ]);
    expect(() => buildChatParams(request)).toThrow(/at most one system message/);
  });

  it("does not merge reasoning into a non-assistant message (standalone instead)", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        { item: item({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "assistant", content: null, reasoning_content: "plan" },
      { role: "user", content: "hi" },
    ]);
  });

  it("reconstructs a reasoning + text + multi-call generation as one native assistant message", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "let me check" }],
          }),
        },
        { item: item({ type: "tool_call", callId: "c1", name: "echo", args: { x: 1 } }) },
        { item: item({ type: "tool_call", callId: "c2", name: "echo", args: { x: 2 } }) },
        {
          item: item({
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "ok1" }],
            status: "ok",
          }),
        },
        {
          item: item({
            type: "tool_result",
            callId: "c2",
            content: [{ type: "text", text: "ok2" }],
            status: "ok",
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "let me check",
        reasoning_content: "plan",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"x":1}' } },
          { id: "c2", type: "function", function: { name: "echo", arguments: '{"x":2}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok1" },
      { role: "tool", tool_call_id: "c2", content: "ok2" },
    ]);
  });

  it("merges reasoning into a single multi-call assistant message with no text", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        { item: item({ type: "tool_call", callId: "c1", name: "echo", args: {} }) },
        { item: item({ type: "tool_call", callId: "c2", name: "echo", args: {} }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "plan",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "echo", arguments: "{}" } },
        ],
      },
    ]);
  });

  it("does not merge reasoning or tool calls across a tool_result boundary", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "call now" }],
          }),
        },
        { item: item({ type: "tool_call", callId: "c1", name: "echo", args: {} }) },
        {
          item: item({
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "ok" }],
            status: "ok",
          }),
        },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "result" }],
          }),
        },
        { item: item({ type: "tool_call", callId: "c2", name: "echo", args: {} }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "call now",
        reasoning_content: "plan",
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      {
        role: "assistant",
        content: "result",
        tool_calls: [{ id: "c2", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
    ]);
  });

  it("folds a reasoning item seen after the text into the same native message", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          }),
        },
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        { item: item({ type: "tool_call", callId: "c", name: "echo", args: {} }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "done",
        reasoning_content: "plan",
        tool_calls: [{ id: "c", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
    ]);
  });

  it("concatenates text across an interleaved reasoning item into one message", () => {
    const params = buildChatParams(
      baseRequest([
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "first" }],
          }),
        },
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: " second" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "first second",
        reasoning_content: "plan",
      },
    ]);
  });

  it("flushes reasoning as a standalone message before a compaction boundary", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        { item: item({ type: "compaction", content: [{ type: "text", text: "summary" }] }) },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "assistant", content: null, reasoning_content: "plan" },
      { role: "user", content: "summary" },
    ]);
  });

  it("keeps reasoning within its own generation across a compaction boundary", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "gen1" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "call" }],
          }),
        },
        { item: item({ type: "tool_call", callId: "c1", name: "echo", args: {} }) },
        {
          item: item({
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "ok" }],
            status: "ok",
          }),
        },
        { item: item({ type: "compaction", content: [{ type: "text", text: "sum" }] }) },
        { item: item({ type: "reasoning", content: [{ type: "text", text: "gen2" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      {
        role: "assistant",
        content: "call",
        reasoning_content: "gen1",
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "user", content: "sum" },
      { role: "assistant", content: "answer", reasoning_content: "gen2" },
    ]);
  });

  it("flushes the open generation before a context boundary", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "plan" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "call" }],
          }),
        },
        { item: item({ type: "tool_call", callId: "c1", name: "echo", args: {} }) },
        {
          item: item({
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "ok" }],
            status: "ok",
          }),
        },
        {
          item: item({
            type: "context",
            key: "agents",
            content: [{ type: "text", text: "project rules" }],
          }),
        },
        { item: item({ type: "reasoning", content: [{ type: "text", text: "gen2" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice\n\nproject rules" },
      {
        role: "assistant",
        content: "call",
        reasoning_content: "plan",
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "answer", reasoning_content: "gen2" },
    ]);
  });

  it("concatenates multiple reasoning items of one generation", () => {
    const params = buildChatParams(
      baseRequest([
        { item: item({ type: "reasoning", content: [{ type: "text", text: "first" }] }) },
        { item: item({ type: "reasoning", content: [{ type: "text", text: " second" }] }) },
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          }),
        },
      ]),
    );
    expect(params.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "assistant", content: "done", reasoning_content: "first second" },
    ]);
  });
});
