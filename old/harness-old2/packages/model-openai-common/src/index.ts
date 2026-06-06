import type {
  Response,
  ResponseCreateParams,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent
} from "openai/resources/responses/responses";
import type { ModelAdapter, ModelOutputObserver } from "@harness/core";
import type {
  ContentBlock,
  JsonValue,
  ModelCapabilities,
  ModelConfig,
  ModelContextMessage,
  ModelStepInput,
  ModelStepResult,
  ProviderEventPayload,
  ProviderState
} from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "harness:model-openai-common:src";
export const OPENAI_RESPONSES_PAYLOAD_VERSION = 1;

export interface OpenAIResponsesClient {
  responses: {
    create(params: ResponseCreateParams): OpenAIResponseCreateResult;
  };
}

export type OpenAIResponseCreateResult =
  | PromiseLike<Response | AsyncIterable<ResponseStreamEvent>>
  | Response
  | AsyncIterable<ResponseStreamEvent>
  | {
      withResponse(): Promise<{
        data: Response | AsyncIterable<ResponseStreamEvent>;
        request_id?: string;
      }>;
    };

export interface OpenAIResponsesSdkAdapterOptions {
  provider: string;
  adapterId: string;
  defaultModel: string;
  stream?: boolean;
  label: string;
  clientFactory: () => OpenAIResponsesClient | Promise<OpenAIResponsesClient>;
  retryClientFactory?: (error: unknown) => OpenAIResponsesClient | Promise<OpenAIResponsesClient | undefined> | undefined;
  extraBody?: Record<string, unknown>;
}

export class OpenAIResponsesSdkAdapter implements ModelAdapter {
  public readonly id: string;
  public readonly provider: string;
  private readonly defaultModel: string;
  private readonly stream: boolean;
  private readonly label: string;
  private readonly clientFactory: () => OpenAIResponsesClient | Promise<OpenAIResponsesClient>;
  private readonly retryClientFactory: ((error: unknown) => OpenAIResponsesClient | Promise<OpenAIResponsesClient | undefined> | undefined) | undefined;
  private readonly extraBody: Record<string, unknown>;

  public constructor(options: OpenAIResponsesSdkAdapterOptions) {
    this.id = options.adapterId;
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.stream = options.stream ?? true;
    this.label = options.label;
    this.clientFactory = options.clientFactory;
    this.retryClientFactory = options.retryClientFactory;
    this.extraBody = options.extraBody ?? {};
  }

  public capabilities(): ModelCapabilities {
    return { textInput: true, textOutput: true, reasoningMetadata: true };
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.provider !== this.provider) {
      throw new Error(`${this.label} cannot run provider ${config.provider}`);
    }
    if (config.adapter !== this.id) {
      throw new Error(`${this.label} cannot run adapter ${config.adapter}`);
    }
  }

  public async step(input: ModelStepInput, observer?: ModelOutputObserver): Promise<ModelStepResult> {
    const params = buildOpenAIResponseParams(input, {
      defaultModel: this.defaultModel,
      stream: this.stream,
      extraBody: this.extraBody
    });
    try {
      return await runOpenAIResponsesStep(input, await this.clientFactory(), params, observer);
    } catch (error) {
      if (!isUnauthorizedError(error) || !this.retryClientFactory) {
        throw error;
      }
      const retryClient = await this.retryClientFactory(error);
      if (!retryClient) {
        throw error;
      }
      return runOpenAIResponsesStep(input, retryClient, params, observer);
    }
  }
}

export interface BuildOpenAIResponseParamsOptions {
  defaultModel: string;
  stream: boolean;
  extraBody?: Record<string, unknown>;
}

export function buildOpenAIResponseParams(input: ModelStepInput, options: BuildOpenAIResponseParamsOptions): ResponseCreateParams {
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
    stream: options.stream,
    store: false,
    include: mergeInclude(providerOptions.include, extraBody.include, "reasoning.encrypted_content"),
    temperature: settings?.temperature,
    top_p: settings?.topP,
    max_output_tokens: settings?.maxOutputTokens
  }) as ResponseCreateParams;
}

export function buildOpenAIResponseInput(input: ModelStepInput): ResponseInput {
  const replay = openAIReplayPayloadForInput(input.providerState);
  let replayIndex = 0;
  const items: ResponseInput = [];

  for (const message of input.messages) {
    if (message.role === "assistant") {
      const match = findMatchingReplaySegment(replay?.segments ?? [], replayIndex, message);
      if (match) {
        replayIndex = match.index + 1;
        items.push(...responseInputItemsFromSegment(match.segment));
        continue;
      }
    }

    const text = renderContentBlocks(message.content);
    if (text.length > 0) {
      items.push({
        type: "message",
        role: message.role,
        content: text
      } as ResponseInputItem);
    }
  }

  return items;
}

export async function runOpenAIResponsesStep(
  input: ModelStepInput,
  client: OpenAIResponsesClient,
  params: ResponseCreateParams,
  observer?: ModelOutputObserver
): Promise<ModelStepResult> {
  const request = await withResponse(client.responses.create(params));
  return isAsyncIterable(request.data)
    ? await collectOpenAIResponsesStream(input, request.data, {
        ...(request.request_id ? { requestId: request.request_id } : {}),
        ...(observer ? { observer } : {})
      })
    : collectOpenAIResponsesObject(input, request.data, request.request_id);
}

export interface CollectOpenAIResponsesOptions {
  requestId?: string;
  observer?: ModelOutputObserver;
}

export async function collectOpenAIResponsesStream(
  input: ModelStepInput,
  stream: AsyncIterable<ResponseStreamEvent>,
  options: CollectOpenAIResponsesOptions = {}
): Promise<ModelStepResult> {
  let completedResponse: Response | undefined;
  let terminalErrorResponse: Response | undefined;
  const outputItems: ResponseOutputItem[] = [];
  const streamedText: string[] = [];
  const providerEvents: ProviderEventPayload[] = [];
  let sequence = 0;
  let terminalEventCount = 0;

  if (options.requestId) {
    providerEvents.push(providerEvent(input, sequence++, "response.request", { requestId: options.requestId }, { providerRequestId: options.requestId }));
  }

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      streamedText.push(event.delta);
      await options.observer?.onTextDelta?.(event.delta);
    }
    if (event.type === "response.output_item.done") {
      outputItems.push(event.item);
      providerEvents.push(providerEvent(input, sequence++, "response.output_item.done", outputItemSummary(event.item), {
        ...providerIds({ providerRequestId: options.requestId, providerItemId: itemId(event.item) })
      }));
    }
    if (event.type === "response.completed") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      completedResponse = event.response;
      providerEvents.push(providerEvent(input, sequence++, "response.completed", responseSummary(event.response), {
        ...providerIds({ providerRequestId: options.requestId }),
        providerResponseId: event.response.id
      }));
    }
    if (event.type === "response.failed" || event.type === "response.incomplete") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      terminalErrorResponse = event.response;
      providerEvents.push(providerEvent(input, sequence++, event.type, responseSummary(event.response), {
        ...providerIds({ providerRequestId: options.requestId }),
        providerResponseId: event.response.id
      }));
    }
    if (event.type === "error") {
      throw openAIStreamEventError(event);
    }
  }

  if (terminalErrorResponse) {
    throw openAIResponseTerminalError(terminalErrorResponse);
  }
  if (!completedResponse) {
    throw new Error("OpenAI response stream ended without response.completed");
  }

  assertCompletedOpenAIResponse(completedResponse);
  const finalOutput = completedResponse.output ?? outputItems;
  const result = resultFromOutput(input, finalOutput, providerEvents, options.requestId, completedResponse);
  if (result.content.length === 0 && streamedText.length > 0) {
    return { ...result, content: [{ type: "text", text: streamedText.join("") }] };
  }
  return result;
}

export function collectOpenAIResponsesObject(input: ModelStepInput, response: Response, requestId: string | undefined): ModelStepResult {
  assertCompletedOpenAIResponse(response);
  const resolvedRequestId = requestId ?? requestIdFromResponse(response);
  const providerEvents: ProviderEventPayload[] = [
    providerEvent(input, 0, "response.completed", responseSummary(response), {
      ...providerIds({ providerRequestId: resolvedRequestId }),
      providerResponseId: response.id
    }),
    ...response.output.map((item, index) => providerEvent(input, index + 1, "response.output_item", outputItemSummary(item), {
      ...providerIds({ providerRequestId: resolvedRequestId, providerItemId: itemId(item) }),
      providerResponseId: response.id
    }))
  ];
  return resultFromOutput(input, response.output, providerEvents, resolvedRequestId, response);
}

export function recordFromJson(value: JsonValue | undefined): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultFromOutput(
  input: ModelStepInput,
  output: ResponseOutputItem[],
  providerEvents: ProviderEventPayload[],
  requestId: string | undefined,
  response?: Response
): ModelStepResult {
  const functionCalls = output.filter((item) => item.type === "function_call");
  if (functionCalls.length > 0) {
    throw new Error("OpenAI returned function calls but harness v0 has no tools");
  }

  const text = output.flatMap((item) => item.type === "message" ? item.content : [])
    .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
    .filter((part) => part.length > 0)
    .join("");

  return {
    content: text.length > 0 ? [{ type: "text", text }] : [],
    providerEvents,
    providerState: providerStateFromOutput(input, output, requestId, response),
    ...(response?.usage === undefined ? {} : { usage: response.usage as unknown as JsonValue }),
    metadata: compactStringRecord({
      providerRequestId: requestId,
      providerResponseId: response?.id,
      model: input.modelConfig.modelId
    })
  };
}

interface OpenAIReplaySegment {
  responseId?: string;
  requestId?: string;
  outputItems: JsonValue[];
  signature: {
    text: string;
  };
}

interface OpenAIReplayPayload {
  include: string[];
  segments: OpenAIReplaySegment[];
}

function openAIReplayPayloadForInput(state: ProviderState | undefined): OpenAIReplayPayload | undefined {
  if (!state || state.payloadVersion !== OPENAI_RESPONSES_PAYLOAD_VERSION) {
    return undefined;
  }
  return parseOpenAIReplayPayload(state.payload);
}

function parseOpenAIReplayPayload(value: JsonValue): OpenAIReplayPayload | undefined {
  if (!isRecord(value) || !Array.isArray(value.segments)) {
    return undefined;
  }
  const segments: OpenAIReplaySegment[] = [];
  for (const raw of value.segments) {
    if (!isRecord(raw) || !Array.isArray(raw.outputItems) || !isRecord(raw.signature)) {
      continue;
    }
    const text = typeof raw.signature.text === "string" ? raw.signature.text : "";
    segments.push({
      ...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}),
      ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
      outputItems: raw.outputItems.filter((item): item is JsonValue => item !== undefined) as JsonValue[],
      signature: { text }
    });
  }
  return {
    include: Array.isArray(value.include) ? value.include.filter((item): item is string => typeof item === "string") : [],
    segments
  };
}

function findMatchingReplaySegment(
  segments: OpenAIReplaySegment[],
  startIndex: number,
  message: ModelContextMessage
): { segment: OpenAIReplaySegment; index: number } | undefined {
  const signature = signatureFromMessage(message);
  for (let index = startIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment && segment.signature.text === signature.text) {
      return { segment, index };
    }
  }
  return undefined;
}

function responseInputItemsFromSegment(segment: OpenAIReplaySegment): ResponseInputItem[] {
  return segment.outputItems
    .filter((item) => !isUnencryptedReasoningItem(item))
    .map((item) => item as unknown as ResponseInputItem);
}

function providerStateFromOutput(
  input: ModelStepInput,
  output: ResponseOutputItem[],
  requestId: string | undefined,
  response: Response | undefined
): ModelStepResult["providerState"] {
  const current = openAIReplayPayloadForInput(input.providerState);
  const segment: OpenAIReplaySegment = {
    ...(response?.id ? { responseId: response.id } : {}),
    ...(requestId ? { requestId } : {}),
    outputItems: output.map((item) => toJsonValue(item)),
    signature: signatureFromOutput(output)
  };
  return {
    payloadVersion: OPENAI_RESPONSES_PAYLOAD_VERSION,
    payload: toJsonValue({
      include: ["reasoning.encrypted_content"],
      segments: [...(current?.segments ?? []), segment]
    }),
    referencedItemSequences: selectedTranscriptSequences(input)
  };
}

function selectedTranscriptSequences(input: ModelStepInput): number[] {
  return input.messages
    .map((message) => message.metadata.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number" && Number.isInteger(sequence) && sequence > 0);
}

function signatureFromMessage(message: ModelContextMessage): OpenAIReplaySegment["signature"] {
  return { text: renderContentBlocks(message.content) };
}

function signatureFromOutput(output: ResponseOutputItem[]): OpenAIReplaySegment["signature"] {
  return {
    text: output.flatMap((item) => item.type === "message" ? item.content : [])
      .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
      .filter((part) => part.length > 0)
      .join("")
  };
}

function renderContentBlocks(blocks: ContentBlock[]): string {
  return blocks.map((block) => renderContentBlock(block)).filter((text) => text.length > 0).join("\n");
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "data":
      return JSON.stringify(block.data);
  }
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

function isUnencryptedReasoningItem(item: JsonValue): boolean {
  return isRecord(item) && item.type === "reasoning" && typeof item.encrypted_content !== "string";
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function assertCompletedOpenAIResponse(response: Response): void {
  const status = isRecord(response) && typeof response.status === "string" ? response.status : undefined;
  if (status === undefined || status === "completed") {
    return;
  }
  throw openAIResponseTerminalError(response);
}

function openAIResponseTerminalError(response: Response): Error {
  const status = isRecord(response) && typeof response.status === "string" ? response.status : "unknown";
  return Object.assign(new Error(`OpenAI response ${response.id} ended with status ${status}`), {
    providerResponseId: response.id,
    responseStatus: status
  });
}

function openAIStreamEventError(event: ResponseStreamEvent): Error {
  const message = isRecord(event) && typeof event.message === "string" ? event.message : "OpenAI response stream emitted an error";
  return Object.assign(new Error(message), { responseStatus: "error" });
}

async function withResponse(created: OpenAIResponseCreateResult): Promise<{ data: Response | AsyncIterable<ResponseStreamEvent>; request_id?: string }> {
  if (hasWithResponse(created)) {
    return created.withResponse();
  }
  return { data: await Promise.resolve(created as PromiseLike<Response | AsyncIterable<ResponseStreamEvent>> | Response | AsyncIterable<ResponseStreamEvent>) };
}

function hasWithResponse(value: OpenAIResponseCreateResult): value is { withResponse(): Promise<{ data: Response | AsyncIterable<ResponseStreamEvent>; request_id?: string }> } {
  return isRecord(value) && typeof value.withResponse === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ResponseStreamEvent> {
  return isRecord(value) && Symbol.asyncIterator in value;
}

function providerEvent(
  input: ModelStepInput,
  sequence: number,
  kind: string,
  normalized: JsonValue,
  ids: { providerRequestId?: string; providerResponseId?: string; providerItemId?: string; providerOperationId?: string } = {}
): ProviderEventPayload {
  return {
    provider: input.modelConfig.provider,
    modelId: input.modelConfig.modelId,
    sequence,
    kind,
    normalized,
    ...(ids.providerRequestId ? { providerRequestId: ids.providerRequestId } : {}),
    ...(ids.providerResponseId ? { providerResponseId: ids.providerResponseId } : {}),
    ...(ids.providerItemId ? { providerItemId: ids.providerItemId } : {}),
    ...(ids.providerOperationId ? { providerOperationId: ids.providerOperationId } : {})
  };
}

function providerIds(ids: {
  providerRequestId?: string | undefined;
  providerResponseId?: string | undefined;
  providerItemId?: string | undefined;
  providerOperationId?: string | undefined;
}): {
  providerRequestId?: string;
  providerResponseId?: string;
  providerItemId?: string;
  providerOperationId?: string;
} {
  return {
    ...(ids.providerRequestId ? { providerRequestId: ids.providerRequestId } : {}),
    ...(ids.providerResponseId ? { providerResponseId: ids.providerResponseId } : {}),
    ...(ids.providerItemId ? { providerItemId: ids.providerItemId } : {}),
    ...(ids.providerOperationId ? { providerOperationId: ids.providerOperationId } : {})
  };
}

function requestIdFromResponse(response: Response): string | undefined {
  return isRecord(response) && typeof response._request_id === "string" ? response._request_id : undefined;
}

function responseSummary(response: Response): JsonValue {
  return {
    id: response.id,
    status: response.status ?? null,
    outputCount: response.output.length,
    usage: response.usage === undefined ? null : response.usage as unknown as JsonValue
  };
}

function outputItemSummary(item: ResponseOutputItem): JsonValue {
  if (item.type === "function_call") {
    return { type: item.type, callId: item.call_id, name: item.name };
  }
  if (item.type === "message") {
    return { type: item.type, id: item.id, contentCount: item.content.length };
  }
  return { type: item.type, id: itemId(item) ?? null };
}

function itemId(item: ResponseOutputItem): string | undefined {
  return isRecord(item) && typeof item.id === "string" ? item.id : undefined;
}

function isUnauthorizedError(error: unknown): boolean {
  return isRecord(error) && (error.status === 401 || error.code === 401 || error.code === "401");
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
