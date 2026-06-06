import { describe, expect, test } from "vitest";
import type { Response, ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import {
  buildOpenAIResponseInput,
  buildOpenAIResponseParams,
  collectOpenAIResponsesObject,
  collectOpenAIResponsesStream
} from "@harness/model-openai-common";
import type { ModelStepInput } from "@harness/protocol";

describe("OpenAI message-only adapter", () => {
  test("maps selected model messages into Responses input items", () => {
    const input = modelInput([
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

  test("rejects function calls because harness v0 has no tools", () => {
    const output = [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "{}" }] as unknown as ResponseOutputItem[];

    expect(() => collectOpenAIResponsesObject(modelInput([{ role: "user", text: "x" }]), response(output), undefined)).toThrow("no tools");
  }, 5000);

  test("rejects tool-enabling provider options before request creation", () => {
    const input = {
      ...modelInput([{ role: "user", text: "x" }]),
      modelConfig: {
        provider: "openai",
        adapter: "responses",
        modelId: "gpt-test",
        providerOptions: { tools: [{ type: "web_search" }] }
      }
    } satisfies ModelStepInput;

    expect(() => buildOpenAIResponseParams(input, { defaultModel: "gpt-test", stream: false })).toThrow("has no tools");
  }, 5000);

  test("fails a stream that ends without a completed terminal response", async () => {
    const stream = asyncEvents([
      { type: "response.output_text.delta", delta: "partial" }
    ]);

    await expect(collectOpenAIResponsesStream(modelInput([{ role: "user", text: "x" }]), stream)).rejects.toThrow("without response.completed");
  }, 5000);

  test("accepts only a completed terminal stream and returns final assistant text", async () => {
    const completed = response([messageOutput("done")]);
    const result = await collectOpenAIResponsesStream(modelInput([{ role: "user", text: "x" }]), asyncEvents([
      { type: "response.output_text.delta", delta: "do" },
      { type: "response.output_text.delta", delta: "ne" },
      { type: "response.completed", response: completed }
    ]));

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result.providerState?.referencedItemSequences).toEqual([1]);
  }, 5000);
});

function modelInput(messages: Array<{ role: "system" | "user" | "assistant"; text: string }>): ModelStepInput {
  return {
    conversationId: "conv_test",
    runId: "run_test",
    modelConfig: { provider: "openai", adapter: "responses", modelId: "gpt-test" },
    messages: messages.map((message, index) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
      metadata: { sequence: index + 1 }
    }))
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

async function* asyncEvents(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}
