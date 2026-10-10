import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { Item, ModelRequest, ModelStreamEvent, ToolSchema } from "@harness/protocol";
import { OpenCodeGoProvider } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

// Real network smoke tests: opt in by exporting OPENCODE_API_KEY (skipped in CI).
const apiKey = process.env.OPENCODE_API_KEY;
const OPENAI_BASE = "https://opencode.ai/zen/go/v1";
const ANTHROPIC_BASE = "https://opencode.ai/zen/go";

const userMessage = {
  id: "i",
  conversationId: "c",
  turnId: "t",
  seq: 0,
  createdAt: 0,
  type: "message",
  role: "user",
  content: [{ type: "text", text: "Reply with the single word: hello" }],
} as Item;

function provider(): OpenCodeGoProvider {
  return new OpenCodeGoProvider({
    openai: { client: () => Promise.resolve(new OpenAI({ apiKey, baseURL: OPENAI_BASE })) },
    anthropic: {
      client: () => Promise.resolve(new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE })),
    },
  });
}

function request(model: string, preset?: string): ModelRequest {
  return {
    instructions: [{ type: "text", text: "You are terse." }],
    modelConfig: { provider: "opencode-go", model, ...(preset ? { preset } : {}) },
    items: [{ item: userMessage }],
  };
}

async function run(model: string, preset?: string): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const e of provider().stream(
    request(model, preset),
    new AbortController().signal,
    CALL_CONTEXT,
  )) {
    events.push(e);
  }
  return events;
}

describe.skipIf(!apiKey)("OpenCodeGoProvider (live)", () => {
  it("streams a chat-family preset turn (deepseek-v4-flash/low) to completion", async () => {
    const events = await run("deepseek-v4-flash", "low");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("streams a responses-family preset turn (gpt-5.6-luna/low) to completion", async () => {
    const events = await run("gpt-5.6-luna", "low");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("streams a messages-family preset turn (minimax-m3/thinking) to completion", async () => {
    const events = await run("minimax-m3", "thinking");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("round-trips a prior reasoning item on the chat family", async () => {
    const priorReasoning = {
      id: "r",
      conversationId: "c",
      turnId: "t",
      seq: 0,
      createdAt: 0,
      type: "reasoning",
      content: [{ type: "text", text: "my plan is to reply with one word: hello" }],
    } as Item;
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "You are terse." }],
      modelConfig: { provider: "opencode-go", model: "deepseek-v4-flash" },
      items: [{ item: priorReasoning }, { item: userMessage }],
    };
    const events: ModelStreamEvent[] = [];
    for await (const e of provider().stream(request, new AbortController().signal, CALL_CONTEXT)) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("round-trips a reasoning + text + tool-call generation on the chat family (the 400 shape)", async () => {
    // The exact reconstruction that produced DeepSeek's "reasoning_content must be
    // passed back" 400: one generation with reasoning, text, and a tool call must
    // render as ONE assistant message carrying all three. The request must carry
    // `tools` (the 400 only fires for tool-carrying requests) and declare the
    // function the fabricated tool_call references.
    const echo: ToolSchema = {
      kind: "function",
      name: "echo",
      description: "echoes the input back",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    };
    const prior = (
      id: string,
      seq: number,
      partial: Partial<Item> & { type: Item["type"] },
    ): Item => ({ id, conversationId: "c", turnId: "t", seq, createdAt: 0, ...partial }) as Item;
    const items: ModelRequest["items"] = [
      {
        item: prior("r", 0, {
          type: "reasoning",
          content: [{ type: "text", text: "my plan is to echo the greeting back" }],
        }),
      },
      {
        item: prior("m", 1, {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Let me echo that." }],
        }),
      },
      {
        item: prior("tc", 2, {
          type: "tool_call",
          callId: "call_echo_1",
          name: "echo",
          args: { text: "hello" },
        }),
      },
      {
        item: prior("tr", 3, {
          type: "tool_result",
          callId: "call_echo_1",
          content: [{ type: "text", text: "hello" }],
          status: "ok",
        }),
      },
    ];
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "You are terse." }],
      modelConfig: { provider: "opencode-go", model: "deepseek-v4-flash" },
      tools: [echo],
      items,
      // The trailing steer mirrors the follow-up request that 400'd.
      prompt: "Now reply with the single word: done",
    };
    const events: ModelStreamEvent[] = [];
    for await (const e of provider().stream(request, new AbortController().signal, CALL_CONTEXT)) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);
});
