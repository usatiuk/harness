import { describe, expect, test } from "vitest";
import { createOpenAIResponsesModelAdapter } from "@harness/model-openai";

const enabled = process.env.HARNESS_LIVE_OPENAI === "1";

describe.skipIf(!enabled)("OpenAI live smoke", () => {
  test("gets one text response from the configured OpenAI Responses model", async () => {
    const adapter = createOpenAIResponsesModelAdapter({ stream: false });
    const result = await adapter.step({
      conversationId: "conv_live",
      runId: "run_live",
      modelConfig: {
        provider: "openai",
        adapter: "responses",
        modelId: process.env.HARNESS_LIVE_OPENAI_MODEL ?? process.env.HARNESS_MODEL ?? "gpt-5.5",
        settings: { maxOutputTokens: 64 }
      },
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Reply with a short plain sentence." }],
        metadata: { sequence: 1 }
      }]
    });

    expect(result.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
  }, 60000);
});
