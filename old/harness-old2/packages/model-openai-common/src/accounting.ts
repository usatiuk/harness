import type { ResponseUsage } from "openai/resources/responses/responses";
import type { ModelAccounting } from "@harness/protocol";

export function openAIAccountingFromUsage(
    usage: ResponseUsage,
): ModelAccounting {
    return { usage: openAITokenUsageFromUsage(usage) };
}

export function openAITokenUsageFromUsage(usage: ResponseUsage): {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
} {
    return {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details.cached_tokens,
        outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
        totalTokens: usage.total_tokens,
    };
}
