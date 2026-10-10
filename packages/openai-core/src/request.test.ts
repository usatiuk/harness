import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { Item, ModelRequest, ProviderPayload } from "@harness/protocol";
import { buildResponseParams, buildChatParams } from "./request.ts";

const REASONING = { effort: "medium", summary: "auto" } as const satisfies OpenAI.Reasoning;

// Items only need their structural fields here; ids/seq/createdAt are irrelevant to mapping.
const item = (partial: Partial<Item> & { type: Item["type"] }): Item =>
  ({ id: "i", conversationId: "c", turnId: "t", seq: 0, createdAt: 0, ...partial }) as Item;

const reasoningPayload = (model: string): ProviderPayload => ({
  itemId: "i" as ProviderPayload["itemId"],
  provider: "openai",
  model,
  type: "reasoning",
  version: 1,
  payload: { id: "rs_1", encryptedContent: "BLOB" },
});

const baseRequest = (items: ModelRequest["items"]): ModelRequest => ({
  instructions: [{ type: "text", text: "be nice" }],
  modelConfig: { provider: "openai", model: "gpt-x" },
  tools: [
    { kind: "function", name: "echo", description: "echoes", parameters: { type: "object" } },
  ],
  items,
});

describe("buildResponseParams", () => {
  it("renders historical raw-string calls as text when no custom tool is offered", () => {
    const params = buildResponseParams(
      baseRequest([
        { item: item({ type: "tool_call", callId: "patch", name: "apply_patch", args: "PATCH" }) },
        {
          item: item({
            type: "tool_result",
            callId: "patch",
            status: "ok",
            content: [{ type: "text", text: "applied" }],
          }),
        },
      ]),
      undefined,
      "openai",
      false,
    );
    expect(params.input).toEqual([
      { role: "assistant", content: "Tool apply_patch: PATCH" },
      { role: "user", content: "applied" },
    ]);
  });

  it.each([null, "commentary", "final_answer", undefined, "foreign"])(
    "preserves supported canonical assistant phase %s without a sidecar",
    (phase) => {
      const request = baseRequest([
        {
          item: item({
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
            ...(phase !== undefined ? { phase } : {}),
          }),
        },
      ]);
      const input = buildResponseParams(request, undefined, "openai", false).input;
      expect(input).toEqual([
        {
          role: "assistant",
          content: "partial",
          ...(phase !== undefined && phase !== "foreign" ? { phase } : {}),
        },
      ]);
    },
  );

  it("declares provider-owned search and forwards toolChoice independently", () => {
    const request = { ...baseRequest([]), providerOptions: { webSearch: true } };
    expect(buildResponseParams(request, undefined, "openai", false).tools).toContainEqual({
      type: "web_search",
    });
    const params = buildResponseParams(
      { ...request, toolChoice: "none" },
      undefined,
      "openai",
      false,
    );
    expect(params.tools).toContainEqual({ type: "web_search" });
    expect(params.tool_choice).toBe("none");
    expect(
      buildResponseParams(baseRequest([]), undefined, "openai", false).tools,
    ).not.toContainEqual({ type: "web_search" });
  });

  it("never sends display-only search hints or their historical metadata", () => {
    const request = baseRequest([
      {
        item: item({
          type: "provider_output",
          content: [{ type: "text", text: "Searched SECRET" }],
        }),
        payload: {
          ...reasoningPayload("gpt-x"),
          type: "response_output",
          payload: { type: "web_search_call", id: "search", status: "in_progress" },
        },
      },
    ]);
    expect(buildResponseParams(request, undefined, "openai", false).input).toEqual([]);
    expect(buildChatParams(request).messages).toEqual([{ role: "system", content: "be nice" }]);
  });

  it("omits reasoning controls unless the connection requests them", () => {
    const params = buildResponseParams(baseRequest([]), undefined, "gateway", false);
    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });
  it("maps items, tools, and instructions onto native Responses params", () => {
    const request = baseRequest([
      { item: item({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) },
      {
        item: item({ type: "reasoning", content: [{ type: "text", text: "summary text" }] }),
        payload: reasoningPayload("gpt-x"),
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

    const params = buildResponseParams(request, REASONING, "openai", true);

    expect(params.model).toBe("gpt-x");
    expect(params.instructions).toBe("be nice");
    expect(params.stream).toBe(true);
    expect(params.store).toBe(false);
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
    expect(params.reasoning).toEqual(REASONING);
    expect(params.tools).toEqual([
      {
        type: "function",
        name: "echo",
        description: "echoes",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
    expect(params.input).toEqual([
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "summary text" }],
        encrypted_content: "BLOB",
      },
      { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"x":1}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  it("appends a non-durable prompt and preserves tools while disabling calls", () => {
    const params = buildResponseParams(
      {
        ...baseRequest([]),
        prompt: "compact now",
        toolChoice: "none",
        maxOutputTokens: 4096,
      },
      REASONING,
      "openai",
      true,
    );
    expect(params.input).toEqual([{ role: "user", content: "compact now" }]);
    expect(params.tool_choice).toBe("none");
    expect(params.tools).toHaveLength(1);
    expect(params.max_output_tokens).toBe(4096);
  });

  it("maps a compaction item to a plain user message", () => {
    const params = buildResponseParams(
      baseRequest([
        {
          item: item({ type: "compaction", content: [{ type: "text", text: "the story so far" }] }),
        },
      ]),
      REASONING,
      "openai",
      true,
    );
    expect(params.input).toEqual([{ role: "user", content: "the story so far" }]);
  });

  it("maps a context item to a developer message", () => {
    const params = buildResponseParams(
      baseRequest([
        {
          item: item({
            type: "context",
            key: "agents-md:src/AGENTS.md",
            content: [{ type: "text", text: "project rules" }],
          }),
        },
      ]),
      REASONING,
      "openai",
      true,
    );
    expect(params.input).toEqual([{ role: "developer", content: "project rules" }]);
  });

  it("keeps a following context item after the function-call output", () => {
    const params = buildResponseParams(
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
      REASONING,
      "openai",
      true,
    );

    expect(params.input).toEqual([
      { type: "function_call", call_id: "c", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "ok" },
      { role: "developer", content: "rules" },
    ]);
  });

  it("skips a reasoning item whose payload is missing or from another provider", () => {
    const reasoning = item({ type: "reasoning", content: [{ type: "text", text: "s" }] });
    const foreign: ProviderPayload = { ...reasoningPayload("gpt-x"), provider: "openai-codex" };

    const noPayload = buildResponseParams(
      baseRequest([{ item: reasoning }]),
      REASONING,
      "openai",
      true,
    );
    const wrongProvider = buildResponseParams(
      baseRequest([{ item: reasoning, payload: foreign }]),
      REASONING,
      "openai",
      true,
    );

    expect(noPayload.input).toEqual([]);
    expect(wrongProvider.input).toEqual([]);
  });

  it("skips a reasoning item whose payload was bound to a different model", () => {
    // baseRequest builds under model "gpt-x"; the blob is from "gpt-old".
    const reasoning = item({ type: "reasoning", content: [{ type: "text", text: "s" }] });
    const params = buildResponseParams(
      baseRequest([{ item: reasoning, payload: reasoningPayload("gpt-old") }]),
      REASONING,
      "openai",
      true,
    );
    expect(params.input).toEqual([]);
  });

  describe("freeform tools (apply_patch)", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n";
    const updateCall = item({
      type: "tool_call",
      callId: "call_p",
      name: "apply_patch",
      args: patch,
    });
    const callResult = item({
      type: "tool_result",
      callId: "call_p",
      content: [{ type: "text", text: "updated a.ts" }],
      status: "ok",
    });
    const patchRequest = (items: ModelRequest["items"]): ModelRequest => ({
      ...baseRequest(items),
      tools: [
        { kind: "function", name: "echo", description: "echoes", parameters: { type: "object" } },
        {
          kind: "custom",
          name: "apply_patch",
          description: "patch",
          grammar: { syntax: "lark", definition: "GRAMMAR" },
        },
      ],
    });

    it("renders a freeform tool as a grammar-constrained custom tool", () => {
      const params = buildResponseParams(patchRequest([]), REASONING, "openai", true);
      expect(params.tools).toContainEqual({
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "GRAMMAR" },
      });
      // Non-freeform tools still render as JSON functions.
      expect(params.tools?.some((t) => t.type === "function" && t.name === "echo")).toBe(true);
    });

    it("round-trips a freeform call/result as custom_tool_call items, args verbatim", () => {
      const params = buildResponseParams(
        patchRequest([{ item: updateCall }, { item: callResult }]),
        REASONING,
        "openai",
        true,
      );
      expect(params.input).toEqual([
        { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: patch },
        { type: "custom_tool_call_output", call_id: "call_p", output: "updated a.ts" },
      ]);
    });

    it("renders a freeform tool without a grammar as a plain custom (text) tool", () => {
      const request: ModelRequest = {
        ...baseRequest([]),
        tools: [{ kind: "custom", name: "scratch", description: "free text" }],
      };
      const params = buildResponseParams(request, REASONING, "openai", true);
      expect(params.tools).toEqual([
        { type: "custom", name: "scratch", description: "free text", format: { type: "text" } },
      ]);
    });
  });
});
