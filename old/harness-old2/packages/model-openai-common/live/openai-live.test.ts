import { describe, expect, test } from "vitest";
import { createOpenAIResponsesModelProvider } from "@harness/model-openai";

const enabled = process.env.HARNESS_LIVE_OPENAI === "1";

describe.skipIf(!enabled)("OpenAI live smoke", () => {
    test("gets one text response from the configured OpenAI Responses model", async () => {
        const provider = createOpenAIResponsesModelProvider();
        let text = "";
        for await (const event of provider.stream({
            conversationId: "conv_live",
            runId: "run_live",
            modelConfig: {
                provider: "openai",
                modelId:
                    process.env.HARNESS_LIVE_OPENAI_MODEL ??
                    process.env.HARNESS_MODEL ??
                    "gpt-5.5",
                settings: { maxOutputTokens: 64 },
            },
            instructions: [],
            items: [
                {
                    itemId: "item_live_1",
                    conversationId: "conv_live",
                    sequence: 1,
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Reply with a short plain sentence.",
                        },
                    ],
                },
            ],
        })) {
            if (event.type === "completed") {
                text = event.response.assistant.content
                    .map((block) => (block.type === "text" ? block.text : ""))
                    .join("");
            }
        }

        expect(text.length).toBeGreaterThan(0);
    }, 60000);
});
