import type {
  ResponseCreateParamsBase,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem
} from "openai/resources/responses/responses";
import type { ContentBlock, ModelRequest } from "@harness/protocol";
import { openAIOutputItemsForContextItem } from "./encoding.ts";
import { compactRecord, recordFromJson, renderContentBlocks } from "./utils.ts";

export interface BuildOpenAIResponseParamsOptions {
  defaultModel: string;
  extraBody?: Record<string, unknown>;
}

export function buildOpenAIResponseParams(input: ModelRequest, options: BuildOpenAIResponseParamsOptions): ResponseCreateParamsStreaming {
  const baseParams = buildOpenAIResponseBaseParams(input, options);
  return { ...baseParams, stream: true };
}

function buildOpenAIResponseBaseParams(
  input: ModelRequest,
  options: BuildOpenAIResponseParamsOptions
): ResponseCreateParamsBase {
  const providerOptions = recordFromJson(input.modelConfig.providerOptions);
  const extraBody = options.extraBody ?? {};
  assertNoToolEnablingOptions(providerOptions);
  assertNoToolEnablingOptions(extraBody);
  const settings = input.modelConfig.settings;
  return compactRecord({
    ...providerOptions,
    ...extraBody,
    model: input.modelConfig.modelId || options.defaultModel,
    input: buildOpenAIResponseInput(input),
    instructions: renderedBlocks(input.instructions),
    store: false,
    include: mergeInclude(providerOptions.include, extraBody.include, "reasoning.encrypted_content"),
    temperature: settings?.temperature,
    top_p: settings?.topP,
    max_output_tokens: settings?.maxOutputTokens
  }) as ResponseCreateParamsBase;
}

export function buildOpenAIResponseInput(input: ModelRequest): ResponseInput {
  const items: ResponseInput = [];
  for (const contextItem of input.items) {
    if (contextItem.item.role === "assistant") {
      const encodedItems = openAIOutputItemsForContextItem(contextItem, input.modelConfig);
      if (encodedItems) {
        items.push(...encodedItems);
        continue;
      }
    }
    if (!contextItem.item.role) {
      continue;
    }
    const text = renderContentBlocks(contextItem.item.content);
    if (text.length > 0) {
      items.push({
        type: "message",
        role: contextItem.item.role,
        content: text
      } as ResponseInputItem);
    }
  }

  return items;
}

function renderedBlocks(blocks: ContentBlock[]): string | undefined {
  const rendered = renderContentBlocks(blocks);
  return rendered.length > 0 ? rendered : undefined;
}

function mergeInclude(...values: unknown[]): string[] {
  const include = new Set<string>();
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      include.add(value);
      continue;
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error("OpenAI Responses include must be a string or string array");
    }
    for (const item of value) {
      include.add(item);
    }
  }
  return [...include];
}

function assertNoToolEnablingOptions(options: Record<string, unknown>): void {
  const blockedKeys = [
    "tools",
    "tool_choice",
    "toolChoice",
    "parallel_tool_calls",
    "parallelToolCalls",
    "available_tools",
    "availableTools",
    "native_tools",
    "nativeTools"
  ];
  for (const key of blockedKeys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(`OpenAI tool option ${key} is not supported because harness v0 has no tools`);
    }
  }
}
