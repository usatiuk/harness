import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseStreamEvent
} from "openai/resources/responses/responses";
import type OpenAI from "openai";
import type { JsonValue, ModelFinalResponseDraft, ModelRequest, ModelStreamEventDraft, ProviderEventPayload } from "@harness/protocol";
import { normalizeOpenAIAccounting, openAIOutputItemsEncodingDraft } from "./encoding.ts";
import { compactStringRecord, isRecord } from "./utils.ts";

export async function* streamOpenAIResponses(
  input: ModelRequest,
  client: Pick<OpenAI, "responses">,
  params: ResponseCreateParamsStreaming
): AsyncIterable<ModelStreamEventDraft> {
  const { data, request_id: requestId } =
    await client.responses.create(params).withResponse();

  yield* collectOpenAIResponsesStream(
    input,
    data,
    requestId ? { requestId } : {}
  );
}

export interface CollectOpenAIResponsesOptions {
  requestId?: string;
}

export async function* collectOpenAIResponsesStream(
  input: ModelRequest,
  stream: AsyncIterable<ResponseStreamEvent>,
  options: CollectOpenAIResponsesOptions = {}
): AsyncIterable<ModelStreamEventDraft> {
  let completedResponse: Response | undefined;
  let terminalErrorResponse: Response | undefined;
  const streamedText: string[] = [];
  let sequence = 0;
  let terminalEventCount = 0;

  if (options.requestId) {
    yield { type: "provider_event", event: providerEvent(input, sequence++, "response.request", { requestId: options.requestId }, { providerRequestId: options.requestId }) };
  }

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      streamedText.push(event.delta);
      yield { type: "text_delta", delta: event.delta };
    }
    if (event.type === "response.output_item.done") {
      yield {
        type: "provider_event",
        event: providerEvent(input, sequence++, "response.output_item.done", outputItemSummary(event.item), {
          ...providerIds({ providerRequestId: options.requestId, providerItemId: itemId(event.item) })
        })
      };
    }
    if (event.type === "response.completed") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      completedResponse = event.response;
      yield {
        type: "provider_event",
        event: providerEvent(input, sequence++, "response.completed", responseSummary(event.response), {
          ...providerIds({ providerRequestId: options.requestId }),
          providerResponseId: event.response.id
        })
      };
    }
    if (event.type === "response.failed" || event.type === "response.incomplete") {
      terminalEventCount += 1;
      if (terminalEventCount > 1) {
        throw new Error("OpenAI response stream emitted multiple terminal events");
      }
      terminalErrorResponse = event.response;
      yield {
        type: "provider_event",
        event: providerEvent(input, sequence++, event.type, responseSummary(event.response), {
          ...providerIds({ providerRequestId: options.requestId }),
          providerResponseId: event.response.id
        })
      };
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
  const result = finalResponseFromOutput(input, completedResponse.output, options.requestId, completedResponse);
  if (result.assistant.content.length === 0 && streamedText.length > 0) {
    yield {
      type: "completed",
      response: {
        ...result,
        assistant: {
          ...result.assistant,
          content: [{ type: "text", text: streamedText.join("") }]
        }
      }
    };
    return;
  }
  yield { type: "completed", response: result };
}

function finalResponseFromOutput(
  input: ModelRequest,
  output: ResponseOutputItem[],
  requestId: string | undefined,
  response?: Response
): ModelFinalResponseDraft {
  const functionCalls = output.filter((item) => item.type === "function_call");
  if (functionCalls.length > 0) {
    throw new Error("OpenAI returned function calls but harness v0 has no tools");
  }

  const text = output.flatMap((item) => item.type === "message" ? item.content : [])
    .map((part) => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
    .filter((part) => part.length > 0)
    .join("");

  const accounting = response?.usage === undefined ? undefined : normalizeOpenAIAccounting(response.usage);
  return {
    assistant: {
      content: text.length > 0 ? [{ type: "text", text }] : [],
      metadata: compactStringRecord({
        providerRequestId: requestId,
        providerResponseId: response?.id,
        model: input.modelConfig.modelId
      }),
      providerEncoding: openAIOutputItemsEncodingDraft(output, requestId, response)
    },
    ...(accounting ? { accounting } : {})
  };
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

function providerEvent(
  input: ModelRequest,
  sequence: number,
  kind: string,
  normalized: JsonValue,
  ids: {
    providerRequestId?: string;
    providerResponseId?: string;
    providerItemId?: string;
    providerOperationId?: string
  } = {}
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
