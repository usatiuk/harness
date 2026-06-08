import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import {
  APPLY_PATCH,
  type Item,
  type ModelRequest,
  type ModelStreamEvent,
} from "@harness/protocol";
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

  it("emits a native apply_patch call as a structured create_file operation", async () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: () => Promise.resolve(new OpenAI({ apiKey })) },
    });
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "Use the apply_patch tool to edit files." }],
      modelConfig: { provider: "openai", model },
      tools: [{ name: APPLY_PATCH, description: "Patch files.", parameters: { type: "object" } }],
      items: [
        {
          item: {
            ...userMessage,
            content: [{ type: "text", text: "Create a file hello.txt containing exactly: hi" }],
          } as Item,
        },
      ],
    };

    const events: ModelStreamEvent[] = [];
    for await (const e of provider.stream(request, new AbortController().signal)) events.push(e);

    const call = events.find((e) => e.type === "tool_call" && e.name === APPLY_PATCH);
    expect(call).toBeDefined();
    const op = (call as Extract<ModelStreamEvent, { type: "tool_call" }>).args as {
      type: string;
      path: string;
      diff: string;
    };
    expect(op.type).toBe("create_file");
    expect(op.path).toContain("hello.txt");
    expect(typeof op.diff).toBe("string");
  }, 60_000);
});
