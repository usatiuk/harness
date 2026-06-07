import { describe, expect, test } from "vitest";
import { createOpenAIResponsesModelAdapter } from "@harness/model-openai";

const enabled = process.env.HARNESS_LIVE_OPENAI === "1";

describe.skipIf(!enabled)("OpenAI live smoke", () => {
  test("gets one text response from the configured OpenAI Responses model", async () => {
    const adapter = createOpenAIResponsesModelAdapter();
    let text = "";
    for await (const event of adapter.stream({
      conversationId: "conv_live",
      runId: "run_live",
      modelConfig: {
        provider: "openai",
        adapter: "responses",
        modelId: process.env.HARNESS_LIVE_OPENAI_MODEL ?? process.env.HARNESS_MODEL ?? "gpt-5.5",
        settings: { maxOutputTokens: 64 }
      },
      instructions: [],
      items: [{
        item: {
          id: "item_live_1",
          conversationId: "conv_live",
          sequence: 1,
          class: "transcript",
          kind: "user_message",
          role: "user",
          visibility: "model",
          content: [{ type: "text", text: "Reply with a short plain sentence." }],
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      }]
    })) {
      if (event.type === "completed") {
        text = event.response.assistant.content
          .map((block) => block.type === "text" ? block.text : "")
          .join("");
      }
    }

    expect(text.length).toBeGreaterThan(0);
  }, 60000);
});
