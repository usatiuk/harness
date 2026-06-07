import { describe, expect, test } from "vitest";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseStreamEvent
} from "openai/resources/responses/responses";
import type OpenAI from "openai";
import {
  OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT,
  OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION,
  OpenAIResponsesSdkAdapter,
  buildOpenAIResponseInput,
  buildOpenAIResponseParams,
  collectOpenAIResponsesStream
} from "@harness/model-openai-common";
import { modelStreamEventSchema, type JsonValue, type ModelRequest, type ModelStreamEvent } from "@harness/protocol";

describe("OpenAI message-only adapter", () => {
  test("maps selected model items into Responses input items", () => {
    const input = modelRequest([
      { role: "system", text: "rules" },
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" }
    ]);

    expect(buildOpenAIResponseInput(input)).toEqual([
      { type: "message", role: "system", content: "rules" },
      { type: "message", role: "user", content: "hello" },
      { type: "message", role: "assistant", content: "hi" }
    ]);
  }, 5000);

  test("always builds a streaming Responses request", () => {
    const input = {
      ...modelRequest([{ role: "user", text: "hello" }]),
      instructions: [{ type: "text", text: "Follow project rules" }]
    } satisfies ModelRequest;

    expect(buildOpenAIResponseParams(input, { defaultModel: "gpt-test" })).toMatchObject({
      instructions: "Follow project rules",
      input: [{ type: "message", role: "user", content: "hello" }],
      stream: true
    });
  }, 5000);

  test("rejects tool-enabling provider options before request creation", () => {
    const input = {
      ...modelRequest([{ role: "user", text: "x" }]),
      modelConfig: {
        provider: "openai",
        adapter: "responses",
        modelId: "gpt-test",
        providerOptions: { tools: [{ type: "web_search" }] }
      }
    } satisfies ModelRequest;

    expect(() => buildOpenAIResponseParams(input, { defaultModel: "gpt-test" })).toThrow("has no tools");
  }, 5000);

  test("rejects function calls because harness v0 has no tools", async () => {
    const output = [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "{}" }] as unknown as ResponseOutputItem[];

    await expect(collectEvents(collectOpenAIResponsesStream(
      modelRequest([{ role: "user", text: "x" }]),
      asyncEvents([{ type: "response.completed", response: response(output) }])
    ))).rejects.toThrow("no tools");
  }, 5000);

  test("fails a stream that ends without a completed terminal response", async () => {
    await expect(collectEvents(collectOpenAIResponsesStream(
      modelRequest([{ role: "user", text: "x" }]),
      asyncEvents([{ type: "response.output_text.delta", delta: "partial" }])
    ))).rejects.toThrow("without response.completed");
  }, 5000);

  test("emits text deltas, provider events, and one completed response", async () => {
    const events = await collectEvents(collectOpenAIResponsesStream(
      modelRequest([{ role: "user", text: "x" }]),
      asyncEvents([
        { type: "response.output_text.delta", delta: "do" },
        { type: "response.output_text.delta", delta: "ne" },
        { type: "response.completed", response: response([messageOutput("done")]) }
      ]),
      { requestId: "req_stream" }
    ));

    expect(events.map((event) => event.type)).toEqual(["provider_event", "text_delta", "text_delta", "provider_event", "completed"]);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["do", "ne"]);
    expect(completed(events).assistant.content).toEqual([{ type: "text", text: "done" }]);
    expect(completed(events).assistant.metadata.providerRequestId).toBe("req_stream");
    expect(completed(events).assistant.providerEncoding).toMatchObject({
      format: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT,
      formatVersion: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION,
      payload: { responseId: "resp_1", requestId: "req_stream" }
    });
  }, 5000);

  test("uses selected assistant provider encoding output items by item id", () => {
    const input = {
      ...modelRequest([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" }
      ]),
      items: [
        contextItem("item_1", 1, "user", "hello"),
        contextItem("item_2", 2, "assistant", "hi", openAIEncoding("item_2", 2, [messageOutput("hi")]))
      ]
    } satisfies ModelRequest;

    expect(buildOpenAIResponseInput(input)).toEqual([
      { type: "message", role: "user", content: "hello" },
      messageOutput("hi")
    ]);
  }, 5000);

  test("uses multiple selected assistant provider encodings in order", () => {
    const input = {
      ...modelRequest([]),
      items: [
        contextItem("item_1", 1, "user", "first"),
        contextItem("item_2", 2, "assistant", "first answer", openAIEncoding("item_2", 2, [messageOutput("first answer")])),
        contextItem("item_3", 3, "user", "second"),
        contextItem("item_4", 4, "assistant", "second answer", openAIEncoding("item_4", 4, [messageOutput("second answer")]))
      ]
    } satisfies ModelRequest;

    expect(buildOpenAIResponseInput(input)).toEqual([
      { type: "message", role: "user", content: "first" },
      messageOutput("first answer"),
      { type: "message", role: "user", content: "second" },
      messageOutput("second answer")
    ]);
  }, 5000);

  test("rejects provider encodings that do not match the selected item and model", () => {
    const input = {
      ...modelRequest([]),
      items: [
        contextItem("item_1", 1, "assistant", "hi", {
          ...openAIEncoding("other_item", 1, [messageOutput("hi")]),
          modelId: "other-model"
        })
      ]
    } satisfies ModelRequest;

    expect(() => buildOpenAIResponseInput(input)).toThrow("Provider encoding does not match");
  }, 5000);

  test("filters unencrypted reasoning output items from provider encodings", () => {
    const unencryptedReasoning = {
      id: "rs_1",
      type: "reasoning",
      summary: []
    };
    const input = {
      ...modelRequest([]),
      items: [
        contextItem("item_1", 1, "assistant", "hi", openAIEncoding("item_1", 1, [
          unencryptedReasoning as unknown as ResponseOutputItem,
          messageOutput("hi")
        ]))
      ]
    } satisfies ModelRequest;

    expect(buildOpenAIResponseInput(input)).toEqual([messageOutput("hi")]);
  }, 5000);

  test("rejects unsupported native output item types from provider encodings", () => {
    const input = {
      ...modelRequest([]),
      items: [
        contextItem("item_1", 1, "assistant", "hi", openAIEncoding("item_1", 1, [
          { id: "call_1", type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" } as unknown as ResponseOutputItem
        ]))
      ]
    } satisfies ModelRequest;

    expect(() => buildOpenAIResponseInput(input)).toThrow("unsupported output item type function_call");
  }, 5000);

  test("adapter stream validates model config before creating a request", async () => {
    const adapter = new OpenAIResponsesSdkAdapter({
      provider: "openai",
      adapterId: "responses",
      defaultModel: "gpt-test",
      label: "test adapter",
      client: async () => {
        throw new Error("client should not be constructed for invalid config");
      }
    });

    await expect(collectEvents(adapter.stream({
      ...modelRequest([{ role: "user", text: "hello" }]),
      modelConfig: { provider: "fake", adapter: "responses", modelId: "gpt-test" }
    }))).rejects.toThrow("cannot run provider fake");
  }, 5000);

  test("adapter stream always uses the streaming SDK path", async () => {
    const client = new StubOpenAIClient({
      data: asyncEvents([
        { type: "response.output_text.delta", delta: "streamed" },
        { type: "response.completed", response: response([messageOutput("streamed")]) }
      ]),
      requestId: "req_stream"
    });
    const adapter = new OpenAIResponsesSdkAdapter({
      provider: "openai",
      adapterId: "responses",
      defaultModel: "gpt-test",
      label: "test adapter",
      client: async () => client as unknown as OpenAI
    });

    const events = await collectEvents(adapter.stream(modelRequest([{ role: "user", text: "hello" }])));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.stream).toBe(true);
    expect(completed(events).assistant.content).toEqual([{ type: "text", text: "streamed" }]);
    expect(completed(events).assistant.metadata.providerRequestId).toBe("req_stream");
    expect(events[0]).toMatchObject({
      type: "provider_event",
      event: {
        kind: "response.request",
        providerRequestId: "req_stream"
      }
    });
  }, 5000);

  test("adapter refreshes ChatGPT-style auth once after an unauthorized response", async () => {
    const expiredClient = new StubOpenAIClient({
      error: Object.assign(new Error("expired token"), { status: 401 })
    });
    const refreshedClient = new StubOpenAIClient({
      data: asyncEvents([{ type: "response.completed", response: response([messageOutput("after refresh")]) }]),
      requestId: "req_refresh"
    });
    let refreshCount = 0;
    const adapter = new OpenAIResponsesSdkAdapter({
      provider: "openai",
      adapterId: "responses",
      defaultModel: "gpt-test",
      label: "test adapter",
      client: async () => expiredClient as unknown as OpenAI,
      refreshClientAfterUnauthorized: async () => {
        refreshCount += 1;
        return refreshedClient as unknown as OpenAI;
      }
    });

    const events = await collectEvents(adapter.stream(modelRequest([{ role: "user", text: "hello" }])));

    expect(refreshCount).toBe(1);
    expect(expiredClient.calls).toHaveLength(1);
    expect(refreshedClient.calls).toHaveLength(1);
    expect(completed(events).assistant.content).toEqual([{ type: "text", text: "after refresh" }]);
    expect(completed(events).assistant.metadata.providerRequestId).toBe("req_refresh");
  }, 5000);
});

function modelRequest(messages: Array<{ role: "system" | "user" | "assistant"; text: string }>): ModelRequest {
  return {
    conversationId: "conv_test",
    runId: "run_test",
    modelConfig: { provider: "openai", adapter: "responses", modelId: "gpt-test" },
    instructions: [],
    items: messages.map((message, index) => contextItem(`item_${index + 1}`, index + 1, message.role, message.text))
  };
}

function contextItem(
  id: string,
  sequence: number,
  role: "system" | "user" | "assistant",
  text: string,
  providerEncoding?: ModelRequest["items"][number]["providerEncoding"]
): ModelRequest["items"][number] {
  return {
    item: {
      id,
      conversationId: "conv_test",
      sequence,
      class: "transcript",
      kind: role === "assistant" ? "assistant_message" : role === "user" ? "user_message" : "system_message",
      role,
      visibility: "model",
      content: [{ type: "text", text }],
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    ...(providerEncoding ? { providerEncoding } : {})
  };
}

function response(output: ResponseOutputItem[], status = "completed"): Response {
  return {
    id: "resp_1",
    status,
    output,
    usage: null
  } as unknown as Response;
}

function messageOutput(text: string): ResponseOutputItem {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  } as unknown as ResponseOutputItem;
}

function openAIEncoding(
  itemId: string,
  itemSequence: number,
  outputItems: ResponseOutputItem[]
): NonNullable<ModelRequest["items"][number]["providerEncoding"]> {
  return {
    id: `penc_${itemSequence}`,
    conversationId: "conv_test",
    itemId,
    itemSequence,
    provider: "openai",
    adapter: "responses",
    modelId: "gpt-test",
    format: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT,
    formatVersion: OPENAI_RESPONSES_OUTPUT_ITEMS_FORMAT_VERSION,
    payload: {
      outputItems: outputItems.map(jsonValue)
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

async function collectEvents(stream: AsyncIterable<unknown>): Promise<ModelStreamEvent[]> {
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

async function* asyncEvents(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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

  public constructor(private readonly result: {
    data?: AsyncIterable<ResponseStreamEvent>;
    requestId?: string;
    error?: unknown;
  }) {
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
          data: this.result.data ?? asyncEvents([{ type: "response.completed", response: response([]) }]),
          request_id: this.result.requestId ?? null,
          response: new globalThis.Response()
        };
      }
    };
  }
}
