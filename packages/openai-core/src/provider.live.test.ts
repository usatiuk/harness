import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { OpenAIResponsesProvider } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

// A real network smoke test: opt in by exporting OPENAI_API_KEY (skipped in CI).
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
const APPLY_PATCH = "apply_patch";

// A minimal V4A grammar (the canonical one lives in @harness/workspace) — enough to confirm
// the API accepts a freeform custom tool.
const APPLY_PATCH_LARK = `start: "*** Begin Patch" LF hunk+ "*** End Patch" LF?
hunk: "*** Add File: " /(.+)/ LF add_line+
add_line: "+" /(.*)/ LF -> line
%import common.LF`;

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
    for await (const e of provider.stream(request, new AbortController().signal, CALL_CONTEXT))
      events.push(e);

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  }, 60_000);

  it("emits a freeform apply_patch call as a raw V4A envelope string", async () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: () => Promise.resolve(new OpenAI({ apiKey })) },
    });
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "Use the apply_patch tool to edit files." }],
      modelConfig: { provider: "openai", model },
      tools: [
        {
          kind: "custom",
          name: APPLY_PATCH,
          description:
            "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not " +
            "wrap the patch in JSON.",
          grammar: { syntax: "lark", definition: APPLY_PATCH_LARK },
        },
      ],
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
    for await (const e of provider.stream(request, new AbortController().signal, CALL_CONTEXT))
      events.push(e);

    const call = events.find((e) => e.type === "tool_call" && e.name === APPLY_PATCH);
    expect(call).toBeDefined();
    const input = (call as Extract<ModelStreamEvent, { type: "tool_call" }>).args;
    expect(typeof input).toBe("string");
    expect(input as string).toContain("*** Begin Patch");
    expect(input as string).toContain("hello.txt");
  }, 60_000);
});
