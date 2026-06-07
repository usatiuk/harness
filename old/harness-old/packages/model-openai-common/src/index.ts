import type {
  FunctionTool,
  Response,
  ResponseCreateParams,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  Tool
} from "openai/resources/responses/responses";
import type { ModelAdapter, ModelOutputObserver } from "@harness/core";
import { createProviderResumeState, providerResumeStateMatches } from "@harness/protocol";
import type {
  ContentBlock,
  JsonValue,
  ModelCapabilities,
  ModelConfig,
  ModelContextMessage,
  ModelStepInput,
  ModelStepResult,
  ProviderEventPayload,
  ProviderResumeState,
  ProviderNativeToolConfig,
  ToolCall,
  ToolDescriptor
} from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "model-openai-common:src";

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
  supportedNativeToolKinds?: string[];
  mapNativeTool: (tool: ProviderNativeToolConfig) => Tool;
}

export class OpenAIResponsesSdkAdapter implements ModelAdapter {
  public readonly id: string;
  public readonly provider: string;
  private readonly defaultModel: string;
  private readonly stream: boolean;
  private readonly label: string;
  private readonly clientFactory: () => OpenAIResponsesClient | Promise<OpenAIResponsesClient>;
  private readonly retryClientFactory: ((error: unknown) => OpenAIResponsesClient | Promise<OpenAIResponsesClient | undefined> | undefined) | undefined;
  private readonly nativeToolKinds: string[];
  private readonly mapNativeTool: (tool: ProviderNativeToolConfig) => Tool;

  public constructor(options: OpenAIResponsesSdkAdapterOptions) {
    this.id = options.adapterId;
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.stream = options.stream ?? true;
    this.label = options.label;
    this.clientFactory = options.clientFactory;
    this.retryClientFactory = options.retryClientFactory;
    this.nativeToolKinds = options.supportedNativeToolKinds ?? ["web_search"];
    this.mapNativeTool = options.mapNativeTool;
  }

  public capabilities(): ModelCapabilities {
    return {
      textInput: true,
      textOutput: true,
      imageInput: false,
      fileInput: false,
      pdfInput: false,
      audioInput: false,
      audioOutput: false,
      toolCalling: true,
      hostedTools: true,
      reasoningMetadata: true
    };
  }

  public supportedNativeToolKinds(): string[] {
    return this.nativeToolKinds;
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
      mapNativeTool: this.mapNativeTool
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
  mapNativeTool: (tool: ProviderNativeToolConfig) => Tool;
  extraBody?: Record<string, unknown>;
}

export function buildOpenAIResponseParams(input: ModelStepInput, options: BuildOpenAIResponseParamsOptions): ResponseCreateParams {
  const model = input.modelConfig.modelId || options.defaultModel;
  const providerOptions = recordFromJson(input.modelConfig.providerOptions);
  const extraBody = options.extraBody ?? {};
  const settings = input.modelConfig.settings;
  const tools = buildOpenAIResponseTools(input, options.mapNativeTool);
  return compactRecord({
    ...providerOptions,
    ...extraBody,
    model,
    input: buildOpenAIResponseInput(input),
    tools: tools.length > 0 ? tools : undefined,
    stream: options.stream,
    store: false,
    include: mergeInclude(providerOptions.include, extraBody.include, "reasoning.encrypted_content"),
    temperature: settings?.temperature,
    top_p: settings?.topP,
    max_output_tokens: settings?.maxOutputTokens
  }) as ResponseCreateParams;
}

export function buildOpenAIResponseInput(input: ModelStepInput): ResponseInput {
  const replay = openAIResumeStateForInput(input);
  let replayIndex = 0;
  const emittedFunctionCalls = new Set<string>();
  const items: ResponseInput = [];
  for (const message of input.messages) {
    if (message.role === "assistant") {
      const segment = findMatchingSegment(replay?.segments ?? [], replayIndex, message);
      if (segment) {
        replayIndex = segment.index + 1;
        for (const item of responseInputItemsFromSegment(segment.segment)) {
          if (isRecord(item) && item.type === "function_call" && typeof item.call_id === "string") {
            emittedFunctionCalls.add(item.call_id);
          }
          items.push(item);
        }
        continue;
      }
    }

    const visibleText = renderContentBlocks(message.content, { omitToolRefs: true });
    if (visibleText.length > 0 && message.role !== "tool") {
      items.push({
        type: "message",
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: visibleText
      } as ResponseInputItem);
    }

    for (const block of message.content) {
      if (block.type === "tool_call_ref") {
        items.push({
          type: "function_call",
          call_id: block.toolCallId,
          name: block.toolName,
          arguments: JSON.stringify(block.input ?? {})
        } as ResponseInputItem);
        emittedFunctionCalls.add(block.toolCallId);
      }
      if (block.type === "tool_result_ref") {
        if (!emittedFunctionCalls.has(block.toolCallId)) {
          throw new Error(`Cannot emit tool output for ${block.toolCallId} before its function call`);
        }
        const output = renderContentBlocks(message.content, { omitToolRefs: true });
        items.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: output.length > 0 ? output : block.status
        } as ResponseInputItem);
      }
    }
  }
  return items;
}

export function buildOpenAIResponseTools(input: ModelStepInput, mapNativeTool: (tool: ProviderNativeToolConfig) => Tool): Tool[] {
  return [
    ...input.availableTools.map((tool) => functionToolFromDescriptor(tool)),
    ...input.modelConfig.nativeTools.filter((tool) => tool.enabled).map(mapNativeTool)
  ];
}

export async function runOpenAIResponsesStep(
  input: ModelStepInput,
  client: OpenAIResponsesClient,
  params: ResponseCreateParams,
  observer?: ModelOutputObserver
): Promise<ModelStepResult> {
  const created = client.responses.create(params);
  const request = await withResponse(created);
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
    if (event.type === "response.web_search_call.in_progress" || event.type === "response.web_search_call.searching" || event.type === "response.web_search_call.completed") {
      providerEvents.push(providerEvent(input, sequence++, `native_tool.web_search.${event.type.split(".").at(-1) ?? "event"}`, event as unknown as JsonValue, {
        ...providerIds({ providerRequestId: options.requestId }),
        providerOperationId: event.item_id
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
    if (event.type === "response.failed") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      terminalErrorResponse = event.response;
      providerEvents.push(providerEvent(input, sequence++, "response.failed", responseSummary(event.response), {
        ...providerIds({ providerRequestId: options.requestId }),
        providerResponseId: event.response.id
      }));
    }
    if (event.type === "response.incomplete") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      terminalErrorResponse = event.response;
      providerEvents.push(providerEvent(input, sequence++, "response.incomplete", responseSummary(event.response), {
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
  const response = completedResponse;
  const finalOutput = response.output ?? outputItems;
  const result = resultFromOutput(input, finalOutput, providerEvents, options.requestId, response);
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
    ...response.output.map((item, index) => providerEvent(input, index + 1, item.type === "web_search_call" ? "native_tool.web_search.completed" : "response.output_item", outputItemSummary(item), {
      ...providerIds({ providerRequestId: resolvedRequestId, providerItemId: itemId(item) }),
      providerResponseId: response.id
    }))
  ];
  return resultFromOutput(input, response.output, providerEvents, resolvedRequestId, response);
}

export function functionToolFromDescriptor(tool: ToolDescriptor): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: parametersFromSchema(tool.inputSchema),
    strict: false
  };
}

export function parseJsonArguments(argumentsJson: string): JsonValue {
  if (argumentsJson.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(argumentsJson) as JsonValue;
  } catch {
    return { rawArguments: argumentsJson };
  }
}

export function recordFromJson(value: JsonValue | undefined): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
  const text = output.flatMap((item) => item.type === "message" ? item.content : [])
    .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
    .filter((part) => part.length > 0)
    .join("");
  const toolCalls = output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call").map((item): ToolCall => ({
    id: item.call_id,
    name: item.name,
    input: parseJsonArguments(item.arguments)
  }));
  const providerResumeState = providerResumeStateFromOutput(input, output, requestId, response);

  return {
    content: text.length > 0 ? [{ type: "text", text }] : [],
    toolCalls,
    providerEvents,
    ...(providerResumeState === undefined ? {} : { providerResumeState }),
    ...(response?.usage === undefined ? {} : { usage: response.usage as unknown as JsonValue }),
    metadata: compactStringRecord({
      providerRequestId: requestId,
      providerResponseId: response?.id,
      model: input.modelConfig.modelId
    })
  };
}

function renderContentBlocks(blocks: ContentBlock[], options: { omitToolRefs: boolean }): string {
  return blocks.map((block) => renderContentBlock(block, options)).filter((text) => text.length > 0).join("\n");
}

function renderContentBlock(block: ContentBlock, options: { omitToolRefs: boolean }): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "data":
      return JSON.stringify(block.data);
    case "image_ref":
      return `[image:${block.assetId}${block.alt ? ` ${block.alt}` : ""}]`;
    case "file_ref":
      return `[file:${block.assetId}${block.filename ? ` ${block.filename}` : ""}]`;
    case "audio_ref":
      return `[audio:${block.assetId}]`;
    case "pdf_ref":
      return `[pdf:${block.assetId}${block.filename ? ` ${block.filename}` : ""}]`;
    case "artifact_ref":
      return `[artifact:${block.artifactId}${block.label ? ` ${block.label}` : ""}]`;
    case "interaction_ref":
      return `[interaction:${block.interactionId}${block.label ? ` ${block.label}` : ""}]`;
    case "activity_ref":
      return `[activity:${block.activityId}${block.label ? ` ${block.label}` : ""}]`;
    case "tool_call_ref":
      return options.omitToolRefs ? "" : `[tool_call:${block.toolName}:${block.toolCallId}]`;
    case "tool_result_ref":
      return options.omitToolRefs ? "" : `[tool_result:${block.status}:${block.toolExecutionId}]`;
  }
}

interface OpenAIResumeSegment {
  turnId: string;
  outputIndex: number;
  responseId?: string;
  requestId?: string;
  outputItems: JsonValue[];
  signature: {
    text: string;
    toolCallIds: string[];
    phases: Array<string | null>;
  };
}

interface OpenAIResumePayload {
  include: string[];
  segments: OpenAIResumeSegment[];
}

const OPENAI_RESPONSES_PAYLOAD_VERSION = 1;

function openAIResumeStateForInput(input: ModelStepInput): OpenAIResumePayload | undefined {
  if (!providerResumeStateMatches(input.modelConfig, input.providerResumeState) || input.providerResumeState?.payloadVersion !== OPENAI_RESPONSES_PAYLOAD_VERSION) {
    return undefined;
  }
  return parseOpenAIResumePayload(input.providerResumeState.payload);
}

function parseOpenAIResumePayload(value: JsonValue): OpenAIResumePayload | undefined {
  if (!isRecord(value) || !Array.isArray(value.segments)) {
    return undefined;
  }
  const segments: OpenAIResumeSegment[] = [];
  for (const segment of value.segments) {
    if (!isRecord(segment) || typeof segment.turnId !== "string" || typeof segment.outputIndex !== "number" || !Array.isArray(segment.outputItems) || !isRecord(segment.signature)) {
      continue;
    }
    const text = typeof segment.signature.text === "string" ? segment.signature.text : "";
    const toolCallIds = Array.isArray(segment.signature.toolCallIds) ? segment.signature.toolCallIds.filter((item): item is string => typeof item === "string") : [];
    const phases = Array.isArray(segment.signature.phases) ? segment.signature.phases.map((item) => typeof item === "string" ? item : null) : [];
    segments.push({
      turnId: segment.turnId,
      outputIndex: segment.outputIndex,
      ...(typeof segment.responseId === "string" ? { responseId: segment.responseId } : {}),
      ...(typeof segment.requestId === "string" ? { requestId: segment.requestId } : {}),
      outputItems: segment.outputItems.filter((item): item is JsonValue => item !== undefined) as JsonValue[],
      signature: { text, toolCallIds, phases }
    });
  }
  return {
    include: Array.isArray(value.include) ? value.include.filter((item): item is string => typeof item === "string") : [],
    segments
  };
}

function findMatchingSegment(segments: OpenAIResumeSegment[], startIndex: number, message: ModelContextMessage): { segment: OpenAIResumeSegment; index: number } | undefined {
  const signature = signatureFromMessage(message);
  const turnId = typeof message.metadata.turnId === "string" ? message.metadata.turnId : undefined;
  for (let index = startIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    if (turnId && segment.turnId !== turnId) {
      continue;
    }
    if (segment.signature.text === signature.text && arraysEqual(segment.signature.toolCallIds, signature.toolCallIds)) {
      return { segment, index };
    }
  }
  return undefined;
}

function responseInputItemsFromSegment(segment: OpenAIResumeSegment): ResponseInputItem[] {
  return segment.outputItems
    .filter((item) => !isUnencryptedReasoningItem(item))
    .map((item) => item as unknown as ResponseInputItem);
}

function providerResumeStateFromOutput(input: ModelStepInput, output: ResponseOutputItem[], requestId: string | undefined, response: Response | undefined): ProviderResumeState | undefined {
  const current = openAIResumeStateForInput(input);
  const segments = current?.segments ?? [];
  const outputIndex = segments.filter((segment) => segment.turnId === input.turnId).length;
  const segment: OpenAIResumeSegment = {
    turnId: input.turnId,
    outputIndex,
    ...(response?.id ? { responseId: response.id } : {}),
    ...(requestId ? { requestId } : {}),
    outputItems: output.map((item) => toJsonValue(item)),
    signature: signatureFromOutput(output)
  };
  return createProviderResumeState({
    modelConfig: input.modelConfig,
    payloadVersion: OPENAI_RESPONSES_PAYLOAD_VERSION,
    payload: toJsonValue({
      include: ["reasoning.encrypted_content"],
      segments: [...segments, segment]
    })
  });
}

function signatureFromMessage(message: ModelContextMessage): OpenAIResumeSegment["signature"] {
  return {
    text: renderContentBlocks(message.content, { omitToolRefs: true }),
    toolCallIds: message.content.filter((block) => block.type === "tool_call_ref").map((block) => block.toolCallId),
    phases: []
  };
}

function signatureFromOutput(output: ResponseOutputItem[]): OpenAIResumeSegment["signature"] {
  return {
    text: output.flatMap((item) => item.type === "message" ? item.content : [])
      .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
      .filter((part) => part.length > 0)
      .join(""),
    toolCallIds: output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call").map((item) => item.call_id),
    phases: output.filter((item) => item.type === "message").map((item) => {
      const phase = isRecord(item) && typeof item.phase === "string" ? item.phase : null;
      return phase;
    })
  };
}

function isUnencryptedReasoningItem(item: JsonValue): boolean {
  return isRecord(item) && item.type === "reasoning" && typeof item.encrypted_content !== "string";
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
  return Object.assign(new Error(message), {
    responseStatus: "error"
  });
}

function parametersFromSchema(schema: JsonValue | undefined): { [key: string]: unknown } {
  if (isRecord(schema)) {
    return schema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
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

function providerIds(ids: { providerRequestId?: string | undefined; providerResponseId?: string | undefined; providerItemId?: string | undefined; providerOperationId?: string | undefined }): {
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
