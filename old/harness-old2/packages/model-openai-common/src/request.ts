import type {
    ResponseCreateParamsStreaming,
    ResponseInput,
} from "openai/resources/responses/responses";
import type { ContentBlock, ModelRequest } from "@harness/protocol";
import { openAIOutputItemsForContextItem } from "./encoding.ts";

const OPENAI_RESPONSE_INCLUDES = ["reasoning.encrypted_content"] as const;

export function buildOpenAIResponseParams(
    input: ModelRequest,
): ResponseCreateParamsStreaming {
    const settings = input.modelConfig.settings;
    const params: ResponseCreateParamsStreaming = {
        model: input.modelConfig.modelId,
        input: buildOpenAIResponseInput(input),
        store: false,
        stream: true,
        include: [...OPENAI_RESPONSE_INCLUDES],
    };
    const instructions = openAITextContent(input.instructions);
    if (instructions !== undefined) {
        params.instructions = instructions;
    }
    if (settings?.temperature !== undefined) {
        params.temperature = settings.temperature;
    }
    if (settings?.topP !== undefined) {
        params.top_p = settings.topP;
    }
    if (settings?.maxOutputTokens !== undefined) {
        params.max_output_tokens = settings.maxOutputTokens;
    }
    return params;
}

export function buildOpenAIResponseInput(input: ModelRequest): ResponseInput {
    const items: ResponseInput = [];
    for (const contextItem of input.items) {
        if (contextItem.role === "assistant") {
            const encodedItems = openAIOutputItemsForContextItem(
                contextItem,
                input.modelConfig,
            );
            if (encodedItems) {
                items.push(...encodedItems);
                continue;
            }
        }
        const text = openAITextContent(contextItem.content);
        if (text !== undefined) {
            items.push({
                type: "message",
                role: contextItem.role,
                content: text,
            });
        }
    }

    return items;
}

function openAITextContent(blocks: ContentBlock[]): string | undefined {
    const text: string[] = [];
    for (const block of blocks) {
        if (block.type !== "text") {
            throw new Error(
                `OpenAI provider cannot render ${block.type} content blocks`,
            );
        }
        if (block.text.length > 0) {
            text.push(block.text);
        }
    }
    return text.length > 0 ? text.join("\n") : undefined;
}
