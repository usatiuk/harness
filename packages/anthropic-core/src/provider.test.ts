import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ContextWindowExceededError, type ModelRequest } from "@harness/protocol";
import { AnthropicProvider } from "./provider.ts";

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "anthropic", model: "claude-sonnet-4-6" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

describe("AnthropicProvider context overflow normalization", () => {
  it("maps a prompt-too-long response to the protocol error", async () => {
    const error = Object.assign(new Error("prompt is too long for this context window"), {
      status: 400,
    });
    const provider = new AnthropicProvider({
      credentials: {
        client: async () =>
          ({ messages: { create: async () => Promise.reject(error) } }) as unknown as Anthropic,
      },
    });

    await expect(
      consume(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it("preserves unrelated provider failures", async () => {
    const error = Object.assign(new Error("context service unavailable"), { status: 500 });
    const provider = new AnthropicProvider({
      credentials: {
        client: async () =>
          ({ messages: { create: async () => Promise.reject(error) } }) as unknown as Anthropic,
      },
    });

    await expect(consume(provider.stream(REQUEST, new AbortController().signal))).rejects.toBe(
      error,
    );
  });
});
