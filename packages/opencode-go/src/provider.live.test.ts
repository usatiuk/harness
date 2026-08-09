import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { OpenCodeGoProvider } from "./provider.ts";

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

function request(model: string): ModelRequest {
  return {
    instructions: [{ type: "text", text: "You are terse." }],
    modelConfig: { provider: "opencode-go", model },
    items: [{ item: userMessage }],
  };
}

async function run(model: string): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const e of provider().stream(request(model), new AbortController().signal)) {
    events.push(e);
  }
  return events;
}

describe.skipIf(!apiKey)("OpenCodeGoProvider (live)", () => {
  it("streams a chat-family turn (deepseek-v4-flash) to completion", async () => {
    const events = await run("deepseek-v4-flash");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("streams a responses-family turn (gpt-5.6-luna) to completion", async () => {
    const events = await run("gpt-5.6-luna");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("streams a messages-family turn (minimax-m2.7) to completion", async () => {
    const events = await run("minimax-m2.7");
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
    for await (const e of provider().stream(request, new AbortController().signal)) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);
});
