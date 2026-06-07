import type { Response, ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import type { JsonValue, ModelAccounting, ModelConfig, ModelContextItem, ProviderEncodingDraft } from "@harness/protocol";
import { isRecord, toJsonValue } from "./utils.ts";

export const OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT = "openai.responses.output_items";
export const OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION = 1;

export function openAIOutputItemsForContextItem(contextItem: ModelContextItem, modelConfig: ModelConfig): ResponseInputItem[] | undefined {
  const encoding = contextItem.providerEncoding;
  if (!encoding) {
    return undefined;
  }
  assertEncodingMatchesContext(contextItem, modelConfig);
  if (encoding.format !== OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT || encoding.formatVersion !== OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION) {
    return undefined;
  }
  const outputItems = openAIOutputItemsFromPayload(encoding.payload);
  return outputItems?.filter((item) => !isUnencryptedReasoningItem(item as unknown as JsonValue));
}

export function openAIOutputItemsEncodingDraft(
  outputItems: ResponseOutputItem[],
  requestId: string | undefined,
  response: Response | undefined
): ProviderEncodingDraft {
  return {
    format: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT,
    formatVersion: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION,
    payload: toJsonValue({
      ...(response?.id ? { responseId: response.id } : {}),
      ...(requestId ? { requestId } : {}),
      outputItems
    })
  };
}

export function normalizeOpenAIAccounting(usage: unknown): ModelAccounting | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const tokenUsage = {
    ...(numberField(usage.input_tokens) !== undefined ? { inputTokens: numberField(usage.input_tokens) } : {}),
    ...(numberField(inputDetails.cached_tokens) !== undefined ? { cachedInputTokens: numberField(inputDetails.cached_tokens) } : {}),
    ...(numberField(usage.output_tokens) !== undefined ? { outputTokens: numberField(usage.output_tokens) } : {}),
    ...(numberField(outputDetails.reasoning_tokens) !== undefined ? { reasoningOutputTokens: numberField(outputDetails.reasoning_tokens) } : {}),
    ...(numberField(usage.total_tokens) !== undefined ? { totalTokens: numberField(usage.total_tokens) } : {})
  };
  return Object.keys(tokenUsage).length > 0 ? { usage: tokenUsage } : undefined;
}

function openAIOutputItemsFromPayload(payload: JsonValue): ResponseInputItem[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.outputItems)) {
    return undefined;
  }
  for (const item of payload.outputItems) {
    assertSupportedNativeOutputItem(item);
  }
  return payload.outputItems.map((item) => item as unknown as ResponseInputItem);
}

function isUnencryptedReasoningItem(item: JsonValue): boolean {
  return isRecord(item) && item.type === "reasoning" && typeof item.encrypted_content !== "string";
}

function assertSupportedNativeOutputItem(item: JsonValue): void {
  if (!isRecord(item) || typeof item.type !== "string") {
    throw new Error("OpenAI provider encoding contains an invalid output item");
  }
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new Error("OpenAI provider encoding contains an invalid assistant message item");
    }
    return;
  }
  if (item.type === "reasoning") {
    return;
  }
  throw new Error(`OpenAI provider encoding contains unsupported output item type ${item.type}`);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertEncodingMatchesContext(contextItem: ModelContextItem, modelConfig: ModelConfig): void {
  const encoding = contextItem.providerEncoding;
  if (!encoding) {
    return;
  }
  const item = contextItem.item;
  const mismatches = [
    encoding.conversationId === item.conversationId ? undefined : "conversationId",
    encoding.itemId === item.id ? undefined : "itemId",
    encoding.itemSequence === item.sequence ? undefined : "itemSequence",
    encoding.provider === modelConfig.provider ? undefined : "provider",
    encoding.adapter === modelConfig.adapter ? undefined : "adapter",
    encoding.modelId === modelConfig.modelId ? undefined : "modelId"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`Provider encoding does not match selected item/model: ${mismatches.join(", ")}`);
  }
}
