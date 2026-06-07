import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { Item, ModelRequest, ProviderPayload } from "@harness/protocol";
import { buildResponseParams } from "./request.ts";

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
  tools: [{ name: "echo", description: "echoes", parameters: { type: "object" } }],
  items,
});

describe("buildResponseParams", () => {
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

    const params = buildResponseParams(request, REASONING);

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

  it("maps a compaction item to a plain user message", () => {
    const params = buildResponseParams(
      baseRequest([
        {
          item: item({ type: "compaction", content: [{ type: "text", text: "the story so far" }] }),
        },
      ]),
      REASONING,
    );
    expect(params.input).toEqual([{ role: "user", content: "the story so far" }]);
  });

  it("skips a reasoning item whose payload is missing or from another provider", () => {
    const reasoning = item({ type: "reasoning", content: [{ type: "text", text: "s" }] });
    const foreign: ProviderPayload = { ...reasoningPayload("gpt-x"), provider: "anthropic" };

    const noPayload = buildResponseParams(baseRequest([{ item: reasoning }]), REASONING);
    const wrongProvider = buildResponseParams(
      baseRequest([{ item: reasoning, payload: foreign }]),
      REASONING,
    );

    expect(noPayload.input).toEqual([]);
    expect(wrongProvider.input).toEqual([]);
  });
});
