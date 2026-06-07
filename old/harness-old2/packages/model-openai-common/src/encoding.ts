import type {
    Response,
    ResponseInputItem,
    ResponseOutputMessage,
    ResponseOutputItem,
    ResponseReasoningItem,
} from "openai/resources/responses/responses";
import type {
    ModelAccounting,
    ModelConfig,
    ModelContextItem,
    ProviderEncodingDraft,
} from "@harness/protocol";
import { z, type JSONType } from "zod";
import { isRecord } from "./utils.ts";

export const OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT =
    "openai.responses.output_items";
export const OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION = 1;

export function openAIOutputItemsForContextItem(
    contextItem: ModelContextItem,
    modelConfig: ModelConfig,
): ResponseInputItem[] | undefined {
    const encoding = contextItem.providerEncoding;
    if (!encoding) {
        return undefined;
    }
    assertEncodingMatchesContext(contextItem, modelConfig);
    if (
        encoding.format !== OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT ||
        encoding.formatVersion !== OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION
    ) {
        return undefined;
    }
    const outputItems = openAIOutputItemsFromPayload(encoding.payload);
    return outputItems?.filter((item) => !isUnencryptedReasoningItem(item));
}

export function openAIOutputItemsEncodingDraft(
    outputItems: ResponseOutputItem[],
    requestId: string | undefined,
    response: Response | undefined,
): ProviderEncodingDraft {
    return {
        format: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT,
        formatVersion: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION,
        payload: z.json().parse({
            ...(response?.id ? { responseId: response.id } : {}),
            ...(requestId ? { requestId } : {}),
            outputItems,
        }),
    };
}

export function normalizeOpenAIAccounting(
    usage: unknown,
): ModelAccounting | undefined {
    if (!isRecord(usage)) {
        return undefined;
    }
    const inputDetails = isRecord(usage.input_tokens_details)
        ? usage.input_tokens_details
        : {};
    const outputDetails = isRecord(usage.output_tokens_details)
        ? usage.output_tokens_details
        : {};
    const tokenUsage = {
        ...(numberField(usage.input_tokens) !== undefined
            ? { inputTokens: numberField(usage.input_tokens) }
            : {}),
        ...(numberField(inputDetails.cached_tokens) !== undefined
            ? { cachedInputTokens: numberField(inputDetails.cached_tokens) }
            : {}),
        ...(numberField(usage.output_tokens) !== undefined
            ? { outputTokens: numberField(usage.output_tokens) }
            : {}),
        ...(numberField(outputDetails.reasoning_tokens) !== undefined
            ? {
                  reasoningOutputTokens: numberField(
                      outputDetails.reasoning_tokens,
                  ),
              }
            : {}),
        ...(numberField(usage.total_tokens) !== undefined
            ? { totalTokens: numberField(usage.total_tokens) }
            : {}),
    };
    return Object.keys(tokenUsage).length > 0
        ? { usage: tokenUsage }
        : undefined;
}

function openAIOutputItemsFromPayload(
    payload: JSONType,
): ResponseInputItem[] | undefined {
    if (!isRecord(payload) || !Array.isArray(payload.outputItems)) {
        return undefined;
    }
    return payload.outputItems.map(toSupportedNativeInputItem);
}

function isUnencryptedReasoningItem(item: unknown): boolean {
    return (
        isRecord(item) &&
        item.type === "reasoning" &&
        typeof item.encrypted_content !== "string"
    );
}

function toSupportedNativeInputItem(item: unknown): ResponseInputItem {
    if (isResponseOutputMessage(item) || isResponseReasoningItem(item)) {
        return item;
    }
    const itemType = isRecord(item) ? item.type : undefined;
    throw new Error(
        `OpenAI provider encoding contains unsupported output item type ${typeof itemType === "string" ? itemType : "unknown"}`,
    );
}

function isResponseOutputMessage(item: unknown): item is ResponseOutputMessage {
    if (!isRecord(item)) {
        return false;
    }
    if (item.type === "message") {
        return (
            typeof item.id === "string" &&
            item.role === "assistant" &&
            isStatus(item.status) &&
            Array.isArray(item.content) &&
            item.content.every(isOutputContentPart) &&
            (item.phase === undefined ||
                item.phase === null ||
                item.phase === "commentary" ||
                item.phase === "final_answer")
        );
    }
    return false;
}

function isResponseReasoningItem(item: unknown): item is ResponseReasoningItem {
    if (!isRecord(item) || item.type !== "reasoning") {
        return false;
    }
    return (
        typeof item.id === "string" &&
        Array.isArray(item.summary) &&
        item.summary.every(isReasoningSummary) &&
        (item.content === undefined ||
            (Array.isArray(item.content) &&
                item.content.every(isReasoningContent))) &&
        (item.encrypted_content === undefined ||
            item.encrypted_content === null ||
            typeof item.encrypted_content === "string") &&
        (item.status === undefined || isStatus(item.status))
    );
}

function isOutputContentPart(item: unknown): boolean {
    if (!isRecord(item) || typeof item.type !== "string") {
        return false;
    }
    if (item.type === "output_text") {
        return typeof item.text === "string" && Array.isArray(item.annotations);
    }
    if (item.type === "refusal") {
        return typeof item.refusal === "string";
    }
    return false;
}

function isReasoningSummary(item: unknown): boolean {
    return (
        isRecord(item) &&
        item.type === "summary_text" &&
        typeof item.text === "string"
    );
}

function isReasoningContent(item: unknown): boolean {
    return (
        isRecord(item) &&
        item.type === "reasoning_text" &&
        typeof item.text === "string"
    );
}

function isStatus(value: unknown): boolean {
    return (
        value === "in_progress" ||
        value === "completed" ||
        value === "incomplete"
    );
}

function numberField(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

function assertEncodingMatchesContext(
    contextItem: ModelContextItem,
    modelConfig: ModelConfig,
): void {
    const encoding = contextItem.providerEncoding;
    if (!encoding) {
        return;
    }
    const item = contextItem.item;
    const mismatches = [
        encoding.conversationId === item.conversationId
            ? undefined
            : "conversationId",
        encoding.itemId === item.id ? undefined : "itemId",
        encoding.itemSequence === item.sequence ? undefined : "itemSequence",
        encoding.provider === modelConfig.provider ? undefined : "provider",
        encoding.adapter === modelConfig.adapter ? undefined : "adapter",
        encoding.modelId === modelConfig.modelId ? undefined : "modelId",
    ].filter((value): value is string => value !== undefined);
    if (mismatches.length > 0) {
        throw new Error(
            `Provider encoding does not match selected item/model: ${mismatches.join(", ")}`,
        );
    }
}
