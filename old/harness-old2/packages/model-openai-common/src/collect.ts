import type {
    Response,
    ResponseCreateParamsStreaming,
    ResponseOutputItem,
    ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type OpenAI from "openai";
import type {
    ModelFinalResponse,
    ModelRequest,
    ModelStreamEvent,
    ProviderResponse,
} from "@harness/protocol";
import { openAIAccountingFromUsage } from "./accounting.ts";
import { openAIOutputItemsPayloadDraft } from "./encoding.ts";

export async function* streamOpenAIResponses(
    input: ModelRequest,
    client: OpenAI,
    params: ResponseCreateParamsStreaming,
): AsyncIterable<ModelStreamEvent> {
    const { data, request_id: requestId } = await client.responses
        .create(params)
        .withResponse();
    const options: CollectOpenAIResponsesOptions = {};
    if (requestId) {
        options.requestId = requestId;
    }
    yield* collectOpenAIResponsesStream(input, data, options);
}

export interface CollectOpenAIResponsesOptions {
    requestId?: string;
}

export async function* collectOpenAIResponsesStream(
    input: ModelRequest,
    stream: AsyncIterable<ResponseStreamEvent>,
    options: CollectOpenAIResponsesOptions = {},
): AsyncIterable<ModelStreamEvent> {
    let completedResponse: Response | undefined;
    let terminalErrorResponse: Response | undefined;
    const streamedText: string[] = [];
    let terminalEventCount = 0;

    for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
            streamedText.push(event.delta);
            yield { type: "text_delta", delta: event.delta };
        }
        if (event.type === "response.completed") {
            terminalEventCount += 1;
            if (terminalEventCount > 1) {
                throw new Error(
                    "OpenAI response stream emitted multiple terminal events",
                );
            }
            completedResponse = event.response;
        }
        if (
            event.type === "response.failed" ||
            event.type === "response.incomplete"
        ) {
            terminalEventCount += 1;
            if (terminalEventCount > 1) {
                throw new Error(
                    "OpenAI response stream emitted multiple terminal events",
                );
            }
            terminalErrorResponse = event.response;
        }
        if (event.type === "error") {
            throw openAIStreamEventError(event);
        }
    }

    if (terminalErrorResponse) {
        throw openAIResponseTerminalError(terminalErrorResponse);
    }
    if (!completedResponse) {
        throw new Error(
            "OpenAI response stream ended without response.completed",
        );
    }

    assertCompletedOpenAIResponse(completedResponse);
    const result = finalResponseFromOutput(
        input,
        completedResponse.output,
        options.requestId,
        completedResponse,
    );
    if (result.assistant.content.length === 0 && streamedText.length > 0) {
        yield {
            type: "completed",
            response: {
                ...result,
                assistant: {
                    ...result.assistant,
                    content: [{ type: "text", text: streamedText.join("") }],
                },
            },
        };
        return;
    }
    yield { type: "completed", response: result };
}

function finalResponseFromOutput(
    input: ModelRequest,
    output: ResponseOutputItem[],
    requestId: string | undefined,
    response: Response,
): ModelFinalResponse {
    const functionCalls = output.filter(
        (item) => item.type === "function_call",
    );
    if (functionCalls.length > 0) {
        throw new Error(
            "OpenAI returned function calls but harness v0 has no tools",
        );
    }

    const text = output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .map((part) =>
            part.type === "output_text"
                ? part.text
                : part.type === "refusal"
                  ? part.refusal
                  : "",
        )
        .filter((part) => part.length > 0)
        .join("");

    const accounting = response.usage
        ? openAIAccountingFromUsage(response.usage)
        : undefined;
    const providerResponse: ProviderResponse = {
        provider: input.modelConfig.provider,
        modelId: input.modelConfig.modelId,
        responseId: response.id,
    };
    if (requestId !== undefined) {
        providerResponse.requestId = requestId;
    }
    return {
        assistant: {
            content: text.length > 0 ? [{ type: "text", text }] : [],
            providerPayload: openAIOutputItemsPayloadDraft(output),
        },
        providerResponse,
        ...(accounting ? { accounting } : {}),
    };
}

function assertCompletedOpenAIResponse(response: Response): void {
    const status = response.status;
    if (status === undefined || status === "completed") {
        return;
    }
    throw openAIResponseTerminalError(response);
}

function openAIResponseTerminalError(response: Response): Error {
    const status = response.status ?? "unknown";
    return Object.assign(
        new Error(`OpenAI response ${response.id} ended with status ${status}`),
        {
            providerResponseId: response.id,
            responseStatus: status,
        },
    );
}

function openAIStreamEventError(
    event: Extract<ResponseStreamEvent, { type: "error" }>,
): Error {
    return Object.assign(new Error(event.message), { responseStatus: "error" });
}
