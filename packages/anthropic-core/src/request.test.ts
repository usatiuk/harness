import { describe, expect, it } from "vitest";
import type { Item, ModelRequest, ProviderPayload } from "@harness/protocol";
import { buildMessages, type AnthropicRequestConfig } from "./request.ts";

const CONFIG: AnthropicRequestConfig = { maxTokens: 1000 };
const PROVIDER = "anthropic";
const MODEL = "claude-x";

// Items only need their structural fields here; ids/seq/createdAt are irrelevant to mapping.
const item = (partial: Partial<Item> & { type: Item["type"] }): Item =>
  ({ id: "i", conversationId: "c", turnId: "t", seq: 0, createdAt: 0, ...partial }) as Item;

const thinkingPayload = (model: string): ProviderPayload => ({
  itemId: "i" as ProviderPayload["itemId"],
  provider: PROVIDER,
  model,
  type: "thinking",
  version: 1,
  payload: { kind: "thinking", thinking: "deep", signature: "S" },
});

const baseRequest = (items: ModelRequest["items"]): ModelRequest => ({
  instructions: [{ type: "text", text: "be nice" }],
  modelConfig: { provider: PROVIDER, model: MODEL },
  tools: [
    { kind: "function", name: "echo", description: "echoes", parameters: { type: "object" } },
    {
      kind: "native",
      name: "str_replace_based_edit_tool",
      description: "edit",
      id: "anthropic.text_editor",
    },
  ],
  items,
});

describe("buildMessages", () => {
  it("groups an assistant turn as [thinking, text, tool_use] and renders system + tools", () => {
    const request = baseRequest([
      { item: item({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) },
      {
        item: item({ type: "reasoning", content: [{ type: "text", text: "deep" }] }),
        payload: thinkingPayload(MODEL),
      },
      {
        item: item({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        }),
      },
      { item: item({ type: "tool_call", callId: "call_1", name: "echo", args: { x: 1 } }) },
      {
        item: item({
          type: "tool_result",
          callId: "call_1",
          content: [{ type: "text", text: "ok" }],
          status: "ok",
        }),
      },
    ]);

    const params = buildMessages(request, CONFIG, PROVIDER);

    expect(params.model).toBe(MODEL);
    expect(params.max_tokens).toBe(1000);
    expect(params.stream).toBe(true);
    expect(params.system).toEqual([
      { type: "text", text: "be nice", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.tools).toEqual([
      { name: "echo", description: "echoes", input_schema: { type: "object" } },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
    ]);
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep", signature: "S" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call_1", name: "echo", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "ok",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("marks an error tool_result with is_error", () => {
    const params = buildMessages(
      baseRequest([
        {
          item: item({
            type: "tool_result",
            callId: "c",
            content: [{ type: "text", text: "boom" }],
            status: "error",
          }),
        },
      ]),
      CONFIG,
      PROVIDER,
    );
    expect(params.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c",
          content: "boom",
          is_error: true,
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  it("drops a thinking block whose payload is missing or from another model", () => {
    const reasoning = item({ type: "reasoning", content: [{ type: "text", text: "x" }] });
    const noPayload = buildMessages(baseRequest([{ item: reasoning }]), CONFIG, PROVIDER);
    const wrongModel = buildMessages(
      baseRequest([{ item: reasoning, payload: thinkingPayload("claude-old") }]),
      CONFIG,
      PROVIDER,
    );
    // The reasoning is the only assistant item; dropping it yields no assistant message at all.
    expect(noPayload.messages).toEqual([]);
    expect(wrongModel.messages).toEqual([]);
  });

  it("batches consecutive user-side items (compaction/context/system) into one user message", () => {
    const params = buildMessages(
      baseRequest([
        { item: item({ type: "compaction", content: [{ type: "text", text: "so far" }] }) },
        { item: item({ type: "context", key: "k", content: [{ type: "text", text: "rules" }] }) },
        {
          item: item({ type: "message", role: "system", content: [{ type: "text", text: "sys" }] }),
        },
      ]),
      CONFIG,
      PROVIDER,
    );
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "so far" },
          { type: "text", text: "rules" },
          { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
  });

  it("batches the results of a parallel tool turn into one user message", () => {
    const params = buildMessages(
      baseRequest([
        { item: item({ type: "tool_call", callId: "a", name: "glob", args: {} }) },
        { item: item({ type: "tool_call", callId: "b", name: "grep", args: {} }) },
        {
          item: item({
            type: "tool_result",
            callId: "a",
            content: [{ type: "text", text: "ra" }],
            status: "ok",
          }),
        },
        {
          item: item({
            type: "tool_result",
            callId: "b",
            content: [{ type: "text", text: "rb" }],
            status: "ok",
          }),
        },
      ]),
      CONFIG,
      PROVIDER,
    );
    expect(params.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "glob", input: {} },
          { type: "tool_use", id: "b", name: "grep", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ra" },
          {
            type: "tool_result",
            tool_use_id: "b",
            content: "rb",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("drops a thinking-only assistant turn (a lone thinking block can't replay)", () => {
    const params = buildMessages(
      baseRequest([
        {
          item: item({ type: "reasoning", content: [{ type: "text", text: "deep" }] }),
          payload: thinkingPayload(MODEL),
        },
        {
          item: item({ type: "message", role: "user", content: [{ type: "text", text: "next" }] }),
        },
      ]),
      CONFIG,
      PROVIDER,
    );
    // No assistant message — the thinking had no text/tool_use to attach to.
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("throws on an unknown native tool id", () => {
    const request: ModelRequest = {
      ...baseRequest([]),
      tools: [{ kind: "native", name: "mystery", description: "?", id: "anthropic.unknown" }],
    };
    expect(() => buildMessages(request, CONFIG, PROVIDER)).toThrow(/unknown native tool/);
  });

  it("renders thinking config and effort when supplied", () => {
    const params = buildMessages(
      baseRequest([]),
      { maxTokens: 500, thinking: { type: "adaptive" }, effort: "high" },
      PROVIDER,
    );
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
  });
});
