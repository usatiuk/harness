import { describe, expect, test } from "vitest";
import {
  OpenAIResponsesModelAdapter,
  buildOpenAIResponseInput,
  buildOpenAIResponseTools,
  type OpenAIResponsesClient
} from "@harness/model-openai";
import { profileConfigSchema, providerResumeStateSchema, type JsonValue, type ModelStepInput } from "@harness/protocol";

describe("OpenAI Responses adapter", () => {
  test("maps a text-only response into harness content and provider metadata", async () => {
    const calls: unknown[] = [];
    const client = mockClient(calls, response([
      outputMessage("msg_1", "hello from OpenAI")
    ], { input_tokens: 3, output_tokens: 4, total_tokens: 7 }));
    const adapter = new OpenAIResponsesModelAdapter({ client, stream: false });

    const result = await adapter.step(modelInput());

    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      stream: false,
      store: false,
      include: expect.arrayContaining(["reasoning.encrypted_content"])
    });
    expect(result.content).toEqual([{ type: "text", text: "hello from OpenAI" }]);
    expect(result.usage).toMatchObject({ total_tokens: 7 });
    expect(result.providerEvents[0]).toMatchObject({
      providerRequestId: "req_test",
      providerResponseId: "resp_1",
      kind: "response.completed"
    });
  });

  test("streams text deltas through the model output observer", async () => {
    const client = mockClient([], streamEvents([
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: response([outputMessage("msg_1", "hello")]) }
    ]));
    const adapter = new OpenAIResponsesModelAdapter({ client });
    const deltas: string[] = [];

    const result = await adapter.step(modelInput(), {
      onTextDelta(delta) {
        deltas.push(delta);
      }
    });

    expect(deltas).toEqual(["hel", "lo"]);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("extracts function calls from response output", async () => {
    const client = mockClient([], response([
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: "{\"command\":\"pwd\"}"
      }
    ]));
    const adapter = new OpenAIResponsesModelAdapter({ client, stream: false });

    const result = await adapter.step(modelInput());

    expect(result.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { command: "pwd" } }]);
  });

  test("reconstructs prior function calls and function outputs from harness messages", () => {
    const input = buildOpenAIResponseInput(modelInput({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "running a tool" },
            { type: "tool_call_ref", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }
          ],
          metadata: {}
        },
        {
          role: "tool",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_result_ref", toolCallId: "call_1", toolExecutionId: "exec_1", status: "ok" }
          ],
          metadata: {}
        }
      ]
    })) as unknown[];

    expect(input).toEqual([
      { type: "message", role: "assistant", content: "running a tool" },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"command\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]);
  });

  test("maps harness tools and native web search into OpenAI tool config", () => {
    const tools = buildOpenAIResponseTools(modelInput({
      availableTools: [
        {
          name: "bash",
          description: "Run shell",
          visibility: "model",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
            additionalProperties: false
          }
        }
      ],
      modelConfig: {
        adapter: "responses",
        provider: "openai",
        modelId: "gpt-test",
        nativeTools: [{ kind: "web_search", enabled: true, options: { type: "file_search", search_context_size: "low" } }]
      }
    }));

    expect(tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "Run shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false
        },
        strict: false
      },
      { type: "web_search", search_context_size: "low" }
    ]);
  });

  test("failed Responses are rejected instead of becoming empty successful turns", async () => {
    const adapter = new OpenAIResponsesModelAdapter({
      client: mockClient([], response([], undefined, "failed")),
      stream: false
    });

    await expect(adapter.step(modelInput())).rejects.toThrow(/ended with status failed/u);
  });

  test("preserves reasoning items in stateless provider resume state", async () => {
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: []
    };
    const adapter = new OpenAIResponsesModelAdapter({
      client: mockClient([], response([reasoningItem, outputMessage("msg_1", "done")])),
      stream: false
    });

    const result = await adapter.step(modelInput());

    expect(result.providerResumeState).toMatchObject({
      version: 1,
      provider: "openai",
      adapter: "responses",
      modelId: "gpt-test",
      payloadVersion: 1,
      payload: {
        include: ["reasoning.encrypted_content"],
        segments: [
          expect.objectContaining({
            turnId: "turn_1",
            outputItems: [reasoningItem, outputMessage("msg_1", "done")],
            signature: expect.objectContaining({ text: "done", toolCallIds: [] })
          })
        ]
      }
    });
    const replay = buildOpenAIResponseInput(modelInput({
      providerResumeState: result.providerResumeState,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          metadata: { turnId: "turn_1" }
        }
      ]
    })) as unknown[];
    expect(replay[0]).toEqual(reasoningItem);
  });

  test("replays stored OpenAI output segments in transcript order and preserves assistant phase", () => {
    const phaseMessage = outputMessage("msg_phase", "draft answer", { phase: "draft" });
    const replay = buildOpenAIResponseInput(modelInput({
      providerResumeState: openAIResumeState({
        segments: [
          {
            turnId: "turn_1",
            outputIndex: 0,
            outputItems: [
              { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [] },
              phaseMessage,
              {
                type: "function_call",
                call_id: "call_1",
                name: "bash",
                arguments: "{\"command\":\"pwd\"}"
              }
            ],
            signature: {
              text: "draft answer",
              toolCallIds: ["call_1"],
              phases: ["draft"]
            }
          }
        ]
      }),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "draft answer" },
            { type: "tool_call_ref", toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }
          ],
          metadata: { turnId: "turn_1" }
        },
        {
          role: "tool",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_result_ref", toolCallId: "call_1", toolExecutionId: "exec_1", status: "ok" }
          ],
          metadata: {}
        }
      ]
    })) as unknown[];

    expect(replay[0]).toMatchObject({ type: "reasoning", encrypted_content: "encrypted" });
    expect(replay[1]).toEqual(phaseMessage);
    expect(replay[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
    expect(replay[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "ok" });
  });

  test("ignores stored provider resume state when owner or payload version does not match", () => {
    const assistantMessage = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "draft answer" },
        { type: "tool_call_ref" as const, toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }
      ],
      metadata: { turnId: "turn_1" }
    };
    const mismatchedAdapter = buildOpenAIResponseInput(modelInput({
      providerResumeState: openAIResumeState({ adapter: "other-adapter" }),
      messages: [assistantMessage]
    })) as unknown[];
    expect(mismatchedAdapter).toEqual([
      { type: "message", role: "assistant", content: "draft answer" },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"command\":\"pwd\"}" }
    ]);

    const mismatchedModel = buildOpenAIResponseInput(modelInput({
      providerResumeState: openAIResumeState({ modelId: "other-model" }),
      messages: [assistantMessage]
    })) as unknown[];
    expect(mismatchedModel).toEqual(mismatchedAdapter);

    const unsupportedPayloadVersion = buildOpenAIResponseInput(modelInput({
      providerResumeState: openAIResumeState({ payloadVersion: 2 }),
      messages: [assistantMessage]
    })) as unknown[];
    expect(unsupportedPayloadVersion).toEqual(mismatchedAdapter);
  });

  test("rejects malformed top-level provider resume state", () => {
    expect(providerResumeStateSchema.safeParse({ version: 1, payload: {} }).success).toBe(false);
    expect(providerResumeStateSchema.safeParse({
      version: 1,
      provider: "openai",
      adapter: "responses",
      modelId: "gpt-test",
      payloadVersion: 1,
      payload: { include: [], segments: [] },
      extra: { version: 1 }
    }).success).toBe(false);
  });

  test("rejects tool outputs that appear before their matching function call", () => {
    expect(() => buildOpenAIResponseInput(modelInput({
      messages: [
        {
          role: "tool",
          content: [
            { type: "text", text: "orphan output" },
            { type: "tool_result_ref", toolCallId: "call_missing", toolExecutionId: "exec_1", status: "ok" }
          ],
          metadata: {}
        }
      ]
    }))).toThrow(/before its function call/u);
  });

  test("rejects streams that end without a completed terminal response", async () => {
    const adapter = new OpenAIResponsesModelAdapter({
      client: mockClient([], streamEvents([
        { type: "response.output_text.delta", delta: "partial" }
      ]))
    });

    await expect(adapter.step(modelInput())).rejects.toThrow(/without response\.completed/u);
  });

  test("rejects failed and incomplete stream terminal responses", async () => {
    const failed = new OpenAIResponsesModelAdapter({
      client: mockClient([], streamEvents([
        { type: "response.failed", response: response([], undefined, "failed") }
      ]))
    });
    await expect(failed.step(modelInput())).rejects.toThrow(/status failed/u);

    const incomplete = new OpenAIResponsesModelAdapter({
      client: mockClient([], streamEvents([
        { type: "response.incomplete", response: response([], undefined, "incomplete") }
      ]))
    });
    await expect(incomplete.step(modelInput())).rejects.toThrow(/status incomplete/u);
  });

  test("rejects streams with duplicate terminal events", async () => {
    const adapter = new OpenAIResponsesModelAdapter({
      client: mockClient([], streamEvents([
        { type: "response.completed", response: response([outputMessage("msg_1", "done")]) },
        { type: "response.completed", response: response([outputMessage("msg_2", "again")]) }
      ]))
    });

    await expect(adapter.step(modelInput())).rejects.toThrow(/multiple terminal events/u);
  });

  test("propagates API errors with request ids intact", async () => {
    const error = Object.assign(new Error("api failed"), { request_id: "req_error", status: 429 });
    const adapter = new OpenAIResponsesModelAdapter({
      client: {
        responses: {
          create: () => ({
            withResponse: async () => {
              throw error;
            }
          })
        }
      },
      stream: false
    });

    await expect(adapter.step(modelInput())).rejects.toMatchObject({
      message: "api failed",
      request_id: "req_error",
      status: 429
    });
  });
});

function modelInput(overrides: Partial<ModelStepInput> = {}): ModelStepInput {
  return {
    conversationId: "conv_1",
    turnId: "turn_1",
    contextBuildId: "ctx_1",
    effectiveProfile: {
      sourceProfileIds: [],
      resolvedAt: "2026-06-06T00:00:00.000Z",
      config: profileConfigSchema.parse({
        model: { adapter: "responses", provider: "openai", modelId: "gpt-test", nativeTools: [] },
        enabledTools: []
      })
    },
    modelConfig: {
      adapter: "responses",
      provider: "openai",
      modelId: "gpt-test",
      nativeTools: []
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: {}
      }
    ],
    availableTools: [],
    unsupportedInputBlocks: [],
    ...overrides
  };
}

function mockClient(calls: unknown[], data: unknown): OpenAIResponsesClient {
  return {
    responses: {
      create(params) {
        calls.push(params);
        return {
          withResponse: async () => ({
            data: data as any,
            request_id: "req_test"
          })
        };
      }
    }
  };
}

function openAIResumeState(overrides: {
  provider?: string;
  adapter?: string;
  modelId?: string;
  payloadVersion?: number;
  segments?: JsonValue[];
} = {}) {
  return providerResumeStateSchema.parse({
    version: 1,
    provider: overrides.provider ?? "openai",
    adapter: overrides.adapter ?? "responses",
    modelId: overrides.modelId ?? "gpt-test",
    payloadVersion: overrides.payloadVersion ?? 1,
    payload: {
      include: ["reasoning.encrypted_content"],
      segments: overrides.segments ?? [
        {
          turnId: "turn_1",
          outputIndex: 0,
          outputItems: [
            { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [] },
            outputMessage("msg_phase", "draft answer"),
            {
              type: "function_call",
              call_id: "call_1",
              name: "bash",
              arguments: "{\"command\":\"pwd\"}"
            }
          ],
          signature: {
            text: "draft answer",
            toolCallIds: ["call_1"],
            phases: [null]
          }
        }
      ]
    }
  });
}

function response(output: unknown[], usage?: unknown, status = "completed"): any {
  return {
    id: "resp_1",
    status,
    output,
    ...(usage === undefined ? {} : { usage }),
    _request_id: "req_runtime"
  };
}

function outputMessage(id: string, text: string, extra: Record<string, unknown> = {}): any {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
    ...extra
  };
}

async function* streamEvents(events: unknown[]): AsyncIterable<any> {
  for (const event of events) {
    yield event;
  }
}
