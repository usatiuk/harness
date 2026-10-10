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
  ],
  items,
});

describe("buildMessages", () => {
  it("declares provider-owned search and forwards toolChoice independently", () => {
    const request = { ...baseRequest([]), providerOptions: { webSearch: true } };
    const tool = { type: "web_search_20250305", name: "web_search" };
    expect(buildMessages(request, CONFIG, PROVIDER).tools).toContainEqual(tool);
    const params = buildMessages({ ...request, toolChoice: "none" }, CONFIG, PROVIDER);
    expect(params.tools).toContainEqual(tool);
    expect(params.tool_choice).toEqual({ type: "none" });
    expect(buildMessages(baseRequest([]), CONFIG, PROVIDER).tools).not.toContainEqual(tool);
  });

  it("never sends display-only search hints or historical search blocks", () => {
    const request = baseRequest([
      {
        item: item({
          type: "provider_output",
          content: [{ type: "text", text: "Searched SECRET" }],
        }),
        payload: {
          ...thinkingPayload(MODEL),
          type: "message_block",
          payload: {
            type: "server_tool_use",
            id: "search",
            name: "web_search",
            input: { query: "SECRET" },
          },
        },
      },
    ]);
    expect(buildMessages(request, CONFIG, PROVIDER).messages).toEqual([]);
  });

  it("appends a non-durable prompt, preserves tools, and uses the resolved output cap", () => {
    const params = buildMessages(
      {
        ...baseRequest([]),
        prompt: "compact now",
        toolChoice: "none",
        maxOutputTokens: 4096,
      },
      CONFIG,
      PROVIDER,
    );
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "compact now", cache_control: { type: "ephemeral" } }],
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "none" });
    expect(params.tools).toHaveLength(1);
    // The connection resolves advisory caps and hard limits before serialization.
    expect(params.max_tokens).toBe(1000);
  });

  it("renders a flat text-editor schema accepted by Anthropic", () => {
    const properties = {
      command: { type: "string", enum: ["view", "create", "str_replace", "insert"] },
      path: { type: "string" },
      file_text: { type: "string" },
    };
    const params = buildMessages(
      {
        ...baseRequest([]),
        tools: [
          {
            kind: "function",
            name: "str_replace_based_edit_tool",
            description: "edit",
            parameters: {
              type: "object",
              properties,
              required: ["command", "path"],
              additionalProperties: false,
            },
          },
        ],
      },
      CONFIG,
      PROVIDER,
    );

    expect(params.tools).toEqual([
      {
        name: "str_replace_based_edit_tool",
        description: "edit",
        input_schema: {
          type: "object",
          properties,
          required: ["command", "path"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it.each(["oneOf", "allOf", "anyOf"] as const)(
    "rejects Anthropic's unsupported top-level %s",
    (keyword) => {
      expect(() =>
        buildMessages(
          {
            ...baseRequest([]),
            tools: [
              {
                kind: "function",
                name: "bad",
                description: "bad",
                parameters: { type: "object", [keyword]: [] },
              },
            ],
          },
          CONFIG,
          PROVIDER,
        ),
      ).toThrow(`anthropic function tool 'bad' does not support top-level ${keyword}`);
    },
  );

  it("rejects an explicitly non-object Anthropic function schema", () => {
    expect(() =>
      buildMessages(
        {
          ...baseRequest([]),
          tools: [
            {
              kind: "function",
              name: "bad",
              description: "bad",
              parameters: { type: "string" },
            },
          ],
        },
        CONFIG,
        PROVIDER,
      ),
    ).toThrow("anthropic function tool 'bad' requires a top-level object input schema");
  });

  it("rejects an Anthropic function schema with no explicit top-level type", () => {
    expect(() =>
      buildMessages(
        {
          ...baseRequest([]),
          tools: [
            {
              kind: "function",
              name: "bad",
              description: "bad",
              parameters: { properties: {} },
            },
          ],
        },
        CONFIG,
        PROVIDER,
      ),
    ).toThrow("anthropic function tool 'bad' requires a top-level object input schema");
  });

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

  it("keeps a following context block after the required tool_result", () => {
    const params = buildMessages(
      baseRequest([
        { item: item({ type: "tool_call", callId: "c", name: "echo", args: {} }) },
        {
          item: item({
            type: "tool_result",
            callId: "c",
            content: [{ type: "text", text: "ok" }],
            status: "ok",
          }),
        },
        {
          item: item({
            type: "context",
            key: "agents",
            content: [{ type: "text", text: "rules" }],
          }),
        },
      ]),
      CONFIG,
      PROVIDER,
    );

    expect(params.messages[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c", content: "ok" },
      { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
    ]);
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
        { item: item({ type: "tool_call", callId: "b", name: "read_file", args: {} }) },
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
          { type: "tool_use", id: "b", name: "read_file", input: {} },
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
