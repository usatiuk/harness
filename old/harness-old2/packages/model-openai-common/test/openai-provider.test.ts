import { describe, expect, test } from "vitest";
import type {
    Response,
    ResponseCreateParamsStreaming,
    ResponseOutputItem,
    ResponseStreamEvent,
    ResponseUsage,
} from "openai/resources/responses/responses";
import OpenAI, { APIError } from "openai";
import {
    OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE,
    OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION,
    OpenAIResponsesProvider,
    buildOpenAIResponseInput,
    buildOpenAIResponseParams,
    collectOpenAIResponsesStream,
} from "@harness/model-openai-common";
import {
    modelStreamEventSchema,
    type ContentBlock,
    type ModelContextItem,
    type ModelRequest,
    type ModelStreamEvent,
    type ProviderPayload,
} from "@harness/protocol";
import type { JSONType } from "zod";

describe("OpenAI Responses model provider", () => {
    test("maps selected model items into Responses input items", () => {
        const input = modelRequest([
            { role: "system", text: "rules" },
            { role: "user", text: "hello" },
            { role: "assistant", text: "hi" },
        ]);

        expect(buildOpenAIResponseInput(input)).toEqual([
            { type: "message", role: "system", content: "rules" },
            { type: "message", role: "user", content: "hello" },
            { type: "message", role: "assistant", content: "hi" },
        ]);
    }, 5000);

    test("always builds a streaming Responses request", () => {
        const input = {
            ...modelRequest([{ role: "user", text: "hello" }]),
            instructions: [{ type: "text", text: "Follow project rules" }],
        } satisfies ModelRequest;

        expect(buildOpenAIResponseParams(input)).toMatchObject({
            instructions: "Follow project rules",
            input: [{ type: "message", role: "user", content: "hello" }],
            model: "gpt-test",
            stream: true,
            store: false,
            include: ["reasoning.encrypted_content"],
        });
    }, 5000);

    test("rejects unsupported content blocks instead of stringifying them", () => {
        const input = {
            ...modelRequest([]),
            items: [
                contextItem("item_1", 1, "user", [
                    {
                        type: "image",
                        source: { type: "url", url: "https://example.com/a.png" },
                    },
                ]),
            ],
        } satisfies ModelRequest;

        expect(() => buildOpenAIResponseInput(input)).toThrow(
            "cannot render image content blocks",
        );
    }, 5000);

    test("rejects function calls because harness v0 has no tools", async () => {
        const output = [
            {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "bash",
                arguments: "{}",
            },
        ] as unknown as ResponseOutputItem[];

        await expect(
            collectEvents(
                collectOpenAIResponsesStream(
                    modelRequest([{ role: "user", text: "x" }]),
                    asyncEvents([
                        {
                            type: "response.completed",
                            response: response(output),
                        },
                    ]),
                ),
            ),
        ).rejects.toThrow("no tools");
    }, 5000);

    test("fails a stream that ends without a completed terminal response", async () => {
        await expect(
            collectEvents(
                collectOpenAIResponsesStream(
                    modelRequest([{ role: "user", text: "x" }]),
                    asyncEvents([
                        {
                            type: "response.output_text.delta",
                            delta: "partial",
                        },
                    ]),
                ),
            ),
        ).rejects.toThrow("without response.completed");
    }, 5000);

    test("emits text deltas and one completed response", async () => {
        const events = await collectEvents(
            collectOpenAIResponsesStream(
                modelRequest([{ role: "user", text: "x" }]),
                asyncEvents([
                    { type: "response.output_text.delta", delta: "do" },
                    { type: "response.output_text.delta", delta: "ne" },
                    {
                        type: "response.completed",
                        response: response([messageOutput("done")]),
                    },
                ]),
                { requestId: "req_stream" },
            ),
        );

        expect(events.map((event) => event.type)).toEqual([
            "text_delta",
            "text_delta",
            "completed",
        ]);
        expect(
            events
                .filter((event) => event.type === "text_delta")
                .map((event) => event.delta),
        ).toEqual(["do", "ne"]);
        expect(completed(events).assistant.content).toEqual([
            { type: "text", text: "done" },
        ]);
        expect(completed(events).providerResponse).toEqual({
            provider: "openai",
            modelId: "gpt-test",
            requestId: "req_stream",
            responseId: "resp_1",
        });
        expect(completed(events).assistant.providerPayload).toMatchObject({
            type: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE,
            version: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION,
            payload: [messageOutput("done")],
        });
    }, 5000);

    test("uses selected assistant provider payload output items by item id", () => {
        const input = {
            ...modelRequest([]),
            items: [
                contextItem("item_1", 1, "user", "hello"),
                contextItem(
                    "item_2",
                    2,
                    "assistant",
                    "hi",
                    openAIProviderPayload("item_2", 2, [messageOutput("hi")]),
                ),
            ],
        } satisfies ModelRequest;

        expect(buildOpenAIResponseInput(input)).toEqual([
            { type: "message", role: "user", content: "hello" },
            messageOutput("hi"),
        ]);
    }, 5000);

    test("replays encrypted reasoning output items as opaque provider-native payload", () => {
        const reasoning = encryptedReasoningOutput("encrypted_reasoning");
        const input = {
            ...modelRequest([]),
            items: [
                contextItem(
                    "item_1",
                    1,
                    "assistant",
                    "hi",
                    openAIProviderPayload("item_1", 1, [
                        reasoning,
                        messageOutput("hi"),
                    ]),
                ),
            ],
        } satisfies ModelRequest;

        expect(buildOpenAIResponseInput(input)).toEqual([
            reasoning,
            messageOutput("hi"),
        ]);
    }, 5000);

    test("uses multiple selected assistant provider payloads in order", () => {
        const input = {
            ...modelRequest([]),
            items: [
                contextItem("item_1", 1, "user", "first"),
                contextItem(
                    "item_2",
                    2,
                    "assistant",
                    "first answer",
                    openAIProviderPayload("item_2", 2, [
                        messageOutput("first answer"),
                    ]),
                ),
                contextItem("item_3", 3, "user", "second"),
                contextItem(
                    "item_4",
                    4,
                    "assistant",
                    "second answer",
                    openAIProviderPayload("item_4", 4, [
                        messageOutput("second answer"),
                    ]),
                ),
            ],
        } satisfies ModelRequest;

        expect(buildOpenAIResponseInput(input)).toEqual([
            { type: "message", role: "user", content: "first" },
            messageOutput("first answer"),
            { type: "message", role: "user", content: "second" },
            messageOutput("second answer"),
        ]);
    }, 5000);

    test("rejects provider payloads that do not match the selected item and model", () => {
        const input = {
            ...modelRequest([]),
            items: [
                contextItem("item_1", 1, "assistant", "hi", {
                    ...openAIProviderPayload("other_item", 1, [
                        messageOutput("hi"),
                    ]),
                    modelId: "other-model",
                }),
            ],
        } satisfies ModelRequest;

        expect(() => buildOpenAIResponseInput(input)).toThrow(
            "Provider payload does not match",
        );
    }, 5000);

    test("provider validates model config before creating a request", async () => {
        const provider = new OpenAIResponsesProvider({
            provider: "openai",
            label: "test provider",
            client: async () => {
                throw new Error(
                    "client should not be constructed for invalid config",
                );
            },
        });

        await expect(
            collectEvents(
                provider.stream({
                    ...modelRequest([{ role: "user", text: "hello" }]),
                    modelConfig: {
                        provider: "fake",
                        modelId: "gpt-test",
                    },
                }),
            ),
        ).rejects.toThrow("cannot run provider fake");
    }, 5000);

    test("provider always uses the streaming SDK path", async () => {
        const client = new StubOpenAIClient({
            data: asyncEvents([
                { type: "response.output_text.delta", delta: "streamed" },
                {
                    type: "response.completed",
                    response: response([messageOutput("streamed")]),
                },
            ]),
            requestId: "req_stream",
        });
        const provider = new OpenAIResponsesProvider({
            provider: "openai",
            label: "test provider",
            client: async () => client as unknown as OpenAI,
        });

        const events = await collectEvents(
            provider.stream(modelRequest([{ role: "user", text: "hello" }])),
        );

        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]?.stream).toBe(true);
        expect(completed(events).assistant.content).toEqual([
            { type: "text", text: "streamed" },
        ]);
        expect(completed(events).providerResponse).toMatchObject({
            requestId: "req_stream",
            responseId: "resp_1",
        });
    }, 5000);

    test("provider refreshes ChatGPT-style auth once after an unauthorized response", async () => {
        const expiredClient = new StubOpenAIClient({
            error: new APIError(401, undefined, "expired token", new Headers()),
        });
        const refreshedClient = new StubOpenAIClient({
            data: asyncEvents([
                {
                    type: "response.completed",
                    response: response([messageOutput("after refresh")]),
                },
            ]),
            requestId: "req_refresh",
        });
        let refreshCount = 0;
        const provider = new OpenAIResponsesProvider({
            provider: "openai",
            label: "test provider",
            client: async () => expiredClient as unknown as OpenAI,
            refreshClientAfterUnauthorized: async () => {
                refreshCount += 1;
                return refreshedClient as unknown as OpenAI;
            },
        });

        const events = await collectEvents(
            provider.stream(modelRequest([{ role: "user", text: "hello" }])),
        );

        expect(refreshCount).toBe(1);
        expect(expiredClient.calls).toHaveLength(1);
        expect(refreshedClient.calls).toHaveLength(1);
        expect(completed(events).assistant.content).toEqual([
            { type: "text", text: "after refresh" },
        ]);
        expect(completed(events).providerResponse).toMatchObject({
            requestId: "req_refresh",
            responseId: "resp_1",
        });
    }, 5000);

    test("maps typed OpenAI usage into model accounting", async () => {
        const events = await collectEvents(
            collectOpenAIResponsesStream(
                modelRequest([{ role: "user", text: "x" }]),
                asyncEvents([
                    {
                        type: "response.completed",
                        response: response([messageOutput("done")], {
                            usage: responseUsage(),
                        }),
                    },
                ]),
            ),
        );

        expect(completed(events).accounting).toEqual({
            usage: {
                inputTokens: 11,
                cachedInputTokens: 3,
                outputTokens: 7,
                reasoningOutputTokens: 5,
                totalTokens: 18,
            },
        });
    }, 5000);
});

function modelRequest(
    messages: Array<{ role: "system" | "user" | "assistant"; text: string }>,
): ModelRequest {
    return {
        conversationId: "conv_test",
        runId: "run_test",
        modelConfig: {
            provider: "openai",
            modelId: "gpt-test",
        },
        instructions: [],
        items: messages.map((message, index) =>
            contextItem(`item_${index + 1}`, index + 1, message.role, [
                { type: "text", text: message.text },
            ]),
        ),
    };
}

function contextItem(
    itemId: string,
    sequence: number,
    role: "system" | "user" | "assistant",
    content: ContentBlock[] | string,
    providerPayload?: ProviderPayload,
): ModelContextItem {
    return {
        itemId,
        conversationId: "conv_test",
        sequence,
        role,
        content:
            typeof content === "string"
                ? [{ type: "text", text: content }]
                : content,
        ...(providerPayload ? { providerPayload } : {}),
    };
}

function response(
    output: ResponseOutputItem[],
    options: { status?: Response["status"]; usage?: ResponseUsage } = {},
): Response {
    return {
        id: "resp_1",
        status: options.status ?? "completed",
        output,
        ...(options.usage ? { usage: options.usage } : {}),
    } as Response;
}

function messageOutput(text: string): ResponseOutputItem {
    return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    } as ResponseOutputItem;
}

function encryptedReasoningOutput(
    encryptedContent: string,
): ResponseOutputItem {
    return {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: encryptedContent,
        summary: [],
        status: "completed",
    } as unknown as ResponseOutputItem;
}

function responseUsage(): ResponseUsage {
    return {
        input_tokens: 11,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 18,
    };
}

function openAIProviderPayload(
    itemId: string,
    itemSequence: number,
    outputItems: ResponseOutputItem[],
): ProviderPayload {
    return {
        id: `ppay_${itemSequence}`,
        conversationId: "conv_test",
        itemId,
        itemSequence,
        provider: "openai",
        modelId: "gpt-test",
        type: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_TYPE,
        version: OPENAI_RESPONSES_OUTPUT_ITEMS_PAYLOAD_VERSION,
        payload: outputItems as unknown as JSONType,
        createdAt: "2026-01-01T00:00:00.000Z",
    };
}

async function collectEvents(
    stream: AsyncIterable<unknown>,
): Promise<ModelStreamEvent[]> {
    const events: ModelStreamEvent[] = [];
    for await (const event of stream) {
        events.push(modelStreamEventSchema.parse(event));
    }
    return events;
}

function completed(events: ModelStreamEvent[]) {
    const event = events.find((candidate) => candidate.type === "completed");
    if (!event || event.type !== "completed") {
        throw new Error("missing completed event");
    }
    return event.response;
}

async function* asyncEvents(
    events: unknown[],
): AsyncIterable<ResponseStreamEvent> {
    for (const event of events) {
        yield event as ResponseStreamEvent;
    }
}

class StubOpenAIClient {
    public readonly calls: ResponseCreateParamsStreaming[] = [];
    public readonly responses: {
        create: (params: ResponseCreateParamsStreaming) => {
            withResponse: () => Promise<{
                data: AsyncIterable<ResponseStreamEvent>;
                request_id: string | null;
                response: globalThis.Response;
            }>;
        };
    };

    public constructor(
        private readonly result: {
            data?: AsyncIterable<ResponseStreamEvent>;
            requestId?: string;
            error?: Error;
        },
    ) {
        this.responses = { create: this.create.bind(this) };
    }

    private create(params: ResponseCreateParamsStreaming) {
        this.calls.push(params);
        return {
            withResponse: async () => {
                if (this.result.error) {
                    throw this.result.error;
                }
                return {
                    data:
                        this.result.data ??
                        asyncEvents([
                            {
                                type: "response.completed",
                                response: response([]),
                            },
                        ]),
                    request_id: this.result.requestId ?? null,
                    response: new globalThis.Response(),
                };
            },
        };
    }
}
