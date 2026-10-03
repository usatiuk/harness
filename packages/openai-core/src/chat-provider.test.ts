import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { ContextWindowExceededError, type ModelRequest } from "@harness/protocol";
import { OpenAIChatTransport } from "./provider.ts";

const REQUEST: ModelRequest = {
  instructions: [{ type: "text", text: "be nice" }],
  items: [],
  modelConfig: { provider: "opencode-go", model: "deepseek-v4-pro" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

describe("OpenAIChatTransport", () => {
  it("builds chat params and streams via client.chat.completions.create", async () => {
    let params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming | undefined;
    const provider = new OpenAIChatTransport({
      provider: "opencode-go",
      credentials: {
        client: async () =>
          ({
            chat: {
              completions: {
                create: async (
                  value: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
                ) => {
                  params = value;
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield {
                        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
                      };
                    },
                  };
                },
              },
            },
          }) as unknown as OpenAI,
      },
    });

    const events: string[] = [];
    for await (const e of provider.stream(REQUEST, new AbortController().signal)) {
      events.push(e.type);
    }
    expect(params?.model).toBe("deepseek-v4-pro");
    expect(events).toEqual(["text_delta", "completed"]);
  });

  it("maps the SDK's typed context error to the protocol error", async () => {
    const error = Object.assign(new Error("maximum context length exceeded"), {
      status: 400,
      code: "context_length_exceeded",
    });
    const provider = new OpenAIChatTransport({
      provider: "opencode-go",
      credentials: {
        client: async () =>
          ({
            chat: { completions: { create: async () => Promise.reject(error) } },
          }) as unknown as OpenAI,
      },
    });

    await expect(
      consume(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it("does not normalize a non-400 failure merely because its message mentions context", async () => {
    const error = Object.assign(new Error("context service unavailable"), { status: 500 });
    const provider = new OpenAIChatTransport({
      provider: "opencode-go",
      credentials: {
        client: async () =>
          ({
            chat: { completions: { create: async () => Promise.reject(error) } },
          }) as unknown as OpenAI,
      },
    });

    await expect(consume(provider.stream(REQUEST, new AbortController().signal))).rejects.toBe(
      error,
    );
  });
});
