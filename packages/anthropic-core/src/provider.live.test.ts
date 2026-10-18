import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Item,
  ModelRequest,
  ModelStreamEvent,
  ProviderPayload,
  ProviderPayloadDraft,
  ToolSchema,
} from "@harness/protocol";
import { AnthropicProvider } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

// A real network smoke test: opt in by exporting ANTHROPIC_API_KEY (skipped in CI).
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const PROVIDER = "anthropic";

const provider = (): AnthropicProvider =>
  new AnthropicProvider({
    credentials: { client: () => Promise.resolve(new Anthropic({ apiKey })) },
  });

const drain = async (request: ModelRequest): Promise<ModelStreamEvent[]> => {
  const events: ModelStreamEvent[] = [];
  for await (const e of provider().stream(request, new AbortController().signal, CALL_CONTEXT))
    events.push(e);
  return events;
};

const userItem = (text: string): Item =>
  ({
    id: "i",
    conversationId: "c",
    turnId: "t",
    seq: 0,
    createdAt: 0,
    type: "message",
    role: "user",
    content: [{ type: "text", text }],
  }) as Item;

const item = (partial: Partial<Item> & { type: Item["type"] }): Item =>
  ({ id: "i", conversationId: "c", turnId: "t", seq: 0, createdAt: 0, ...partial }) as Item;

const withItemId = (draft: ProviderPayloadDraft): ProviderPayload => ({
  ...draft,
  itemId: "i" as ProviderPayload["itemId"],
});

const weatherTool: ToolSchema = {
  kind: "function",
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

describe.skipIf(!apiKey)("AnthropicProvider (live)", () => {
  it("streams a real turn to completion", async () => {
    const events = await drain({
      instructions: [{ type: "text", text: "You are terse." }],
      modelConfig: { provider: PROVIDER, model },
      items: [{ item: userItem("Reply with the single word: hello") }],
    });
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  // The highest-risk invariant: a thinking block carries a signature that must replay UNCHANGED
  // on the same model across a tool call, or the API rejects the follow-up request.
  it("round-trips a thinking signature across a tool call", async () => {
    const first = await drain({
      instructions: [{ type: "text", text: "Use tools when needed. Think before answering." }],
      modelConfig: { provider: PROVIDER, model },
      tools: [weatherTool],
      items: [{ item: userItem("What's the weather in Paris? Use the tool.") }],
    });

    const call = first.find((e) => e.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    const reasoning = first.find((e) => e.type === "reasoning");
    // Replaying the prior turn — including the thinking payload — must not 400.
    const priorItems: ModelRequest["items"] = [
      { item: userItem("What's the weather in Paris? Use the tool.") },
      ...(reasoning && reasoning.type === "reasoning" && reasoning.payload
        ? [
            {
              item: item({ type: "reasoning", content: reasoning.content }),
              payload: withItemId(reasoning.payload),
            },
          ]
        : []),
      {
        item: item({
          type: "tool_call",
          callId: (call as Extract<ModelStreamEvent, { type: "tool_call" }>).callId,
          name: "get_weather",
          args: (call as Extract<ModelStreamEvent, { type: "tool_call" }>).args,
        }),
      },
      {
        item: item({
          type: "tool_result",
          callId: (call as Extract<ModelStreamEvent, { type: "tool_call" }>).callId,
          content: [{ type: "text", text: "18°C and sunny" }],
          status: "ok",
        }),
      },
    ];

    const second = await drain({
      instructions: [{ type: "text", text: "Use tools when needed. Think before answering." }],
      modelConfig: { provider: PROVIDER, model },
      tools: [weatherTool],
      items: priorItems,
    });
    expect(second.at(-1)?.type).toBe("completed");
    expect(second.some((e) => e.type === "text_delta")).toBe(true);
  }, 120_000);

  it("emits a write function call to create a file", async () => {
    const events = await drain({
      instructions: [{ type: "text", text: "Use the write tool to create files." }],
      modelConfig: { provider: PROVIDER, model },
      tools: [
        {
          kind: "function",
          name: "write",
          description: "the file editor",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ],
      items: [{ item: userItem("Create a file hello.txt containing exactly: hi") }],
    });

    const call = events.find((e) => e.type === "tool_call" && e.name === "write");
    expect(call).toBeDefined();
    const args = (call as Extract<ModelStreamEvent, { type: "tool_call" }>).args as {
      path?: string;
      content?: string;
    };
    expect(args.path).toBe("hello.txt");
    expect(args.content?.trim()).toBe("hi");
  }, 60_000);
});
