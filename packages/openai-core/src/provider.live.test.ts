import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { OpenAIResponsesProvider } from "./provider.ts";

// A real network smoke test: opt in by exporting OPENAI_API_KEY (skipped in CI).
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-5.1";

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

describe.skipIf(!apiKey)("OpenAIResponsesProvider (live)", () => {
  it("streams a real turn to completion", async () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: () => Promise.resolve(new OpenAI({ apiKey })) },
    });
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "You are terse." }],
      modelConfig: { provider: "openai", model },
      items: [{ item: userMessage }],
    };

    const events: ModelStreamEvent[] = [];
    for await (const e of provider.stream(request, new AbortController().signal)) events.push(e);

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);
});
