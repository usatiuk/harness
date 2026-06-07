import type {
    ResponseInputItem,
    ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
    ModelConfig,
    ModelContextItem,
    ProviderPayloadDraft,
} from "@harness/protocol";
import type { JSONType } from "zod";

export const OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE =
    "responses.output_items";
export const OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION = 1;

export function openAIOutputItemsForContextItem(
    contextItem: ModelContextItem,
    modelConfig: ModelConfig,
): ResponseInputItem[] | undefined {
    const payload = contextItem.providerPayload;
    if (!payload) {
        return undefined;
    }
    assertPayloadMatchesContext(contextItem, modelConfig);
    if (
        payload.type !== OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE ||
        payload.version !== OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION
    ) {
        return undefined;
    }
    if (!Array.isArray(payload.payload)) {
        throw new Error("OpenAI provider payload must be an output item array");
    }
    return payload.payload as unknown as ResponseInputItem[];
}

export function openAIOutputItemsPayloadDraft(
    outputItems: ResponseOutputItem[],
): ProviderPayloadDraft {
    return {
        type: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE,
        version: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION,
        payload: outputItems as unknown as JSONType,
    };
}

function assertPayloadMatchesContext(
    contextItem: ModelContextItem,
    modelConfig: ModelConfig,
): void {
    const payload = contextItem.providerPayload;
    if (!payload) {
        return;
    }
    const mismatches = [
        payload.conversationId === contextItem.conversationId
            ? undefined
            : "conversationId",
        payload.itemId === contextItem.itemId ? undefined : "itemId",
        payload.itemSequence === contextItem.sequence
            ? undefined
            : "itemSequence",
        payload.provider === modelConfig.provider ? undefined : "provider",
        payload.modelId === modelConfig.modelId ? undefined : "modelId",
    ].filter((value): value is string => value !== undefined);
    if (mismatches.length > 0) {
        throw new Error(
            `Provider payload does not match selected item/model: ${mismatches.join(", ")}`,
        );
    }
}
