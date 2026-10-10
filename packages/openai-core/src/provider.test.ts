import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { ContextWindowExceededError, type ModelRequest } from "@harness/protocol";
import { OPENAI_MODELS, OpenAIResponsesProvider, reasoningForSelection } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

const BASE: OpenAI.Reasoning = { effort: "medium", summary: "auto" };
const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "openai", model: "gpt-5.1" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

describe("reasoningForSelection", () => {
  it("uses the chosen preset when the model offers it, keeping other base fields", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1", preset: "high" }, BASE);
    expect(r).toEqual({ effort: "high", summary: "auto" });
  });

  it("falls back to the model default when preset is absent", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1" }, BASE);
    expect(r.effort).toBe("medium");
  });

  it("falls back to the model default when preset is not offered", () => {
    // codex does not offer `none`
    const r = reasoningForSelection(
      { provider: "openai", model: "gpt-5.3-codex", preset: "none" },
      BASE,
    );
    expect(r.effort).toBe("medium");
  });

  it("leaves base untouched for an unknown model", () => {
    const r = reasoningForSelection({ provider: "openai", model: "mystery", preset: "high" }, BASE);
    expect(r).toBe(BASE);
  });
});

describe("listModels", () => {
  it("declares per-model presets and a default", () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: async () => ({}) as never },
    });
    const models = provider.listModels();
    const gpt = models.find((m) => m.model === "gpt-5.1");
    expect(gpt?.defaultPreset).toBe("medium");
    expect(gpt?.presets?.map((e) => e.value)).toEqual(["none", "low", "medium", "high"]);
  });

  it("overrides context and output limits for only the named model", () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: async () => ({}) as never },
      models: OPENAI_MODELS.map((model) =>
        model.model === "gpt-5.1"
          ? { ...model, contextWindow: 200_000, maxOutputTokens: 64_000 }
          : model,
      ),
    });
    const models = provider.listModels();

    expect(models.find((m) => m.model === "gpt-5.1")).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(models.find((m) => m.model === "gpt-5.5")).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });
});

describe("request parameters", () => {
  it.each([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ])("sends max reasoning and stateless tools for %s", async (model) => {
    let params: OpenAI.Responses.ResponseCreateParamsStreaming | undefined;
    const provider = new OpenAIResponsesProvider({
      credentials: {
        client: async () =>
          ({
            responses: {
              create: async (value: OpenAI.Responses.ResponseCreateParamsStreaming) => {
                params = value;
                return { async *[Symbol.asyncIterator]() {} };
              },
            },
          }) as unknown as OpenAI,
      },
    });
    await consume(
      provider.stream(
        {
          ...REQUEST,
          modelConfig: { provider: "openai", model, preset: "max" },
          tools: [
            {
              kind: "function",
              name: "echo",
              description: "Echo",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        new AbortController().signal,
        CALL_CONTEXT,
      ),
    );
    expect(params).toMatchObject({
      model,
      reasoning: { effort: "max" },
      stream: true,
      store: false,
      tools: [{ type: "function", name: "echo" }],
    });
    expect(provider.listModels().find((entry) => entry.model === model)).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });

  it.each(["gpt-6.1-sol", "gpt-6-astra"])("rejects none reasoning for %s", (model) => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: async () => ({}) as never },
    });
    expect(() => provider.validateConfig({ provider: "openai", model, preset: "none" })).toThrow(
      "unknown preset",
    );
  });
  it("omits max_output_tokens for a transport that does not support it", async () => {
    let params: OpenAI.Responses.ResponseCreateParamsStreaming | undefined;
    const provider = new OpenAIResponsesProvider({
      credentials: {
        client: async () =>
          ({
            responses: {
              create: async (value: OpenAI.Responses.ResponseCreateParamsStreaming) => {
                params = value;
                return {
                  async *[Symbol.asyncIterator]() {},
                };
              },
            },
          }) as unknown as OpenAI,
      },
      supportsMaxOutputTokens: false,
    });

    await consume(
      provider.stream(
        { ...REQUEST, maxOutputTokens: 128_000 },
        new AbortController().signal,
        CALL_CONTEXT,
      ),
    );

    expect(params).not.toHaveProperty("max_output_tokens");
  });
});

describe("context overflow normalization", () => {
  it("maps the SDK's typed context error to the protocol error", async () => {
    const error = Object.assign(new Error("maximum context length exceeded"), {
      status: 400,
      code: "context_length_exceeded",
    });
    const provider = new OpenAIResponsesProvider({
      credentials: {
        client: async () =>
          ({ responses: { create: async () => Promise.reject(error) } }) as unknown as OpenAI,
      },
    });

    await expect(
      consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it("does not normalize a non-400 failure merely because its message mentions context", async () => {
    const error = Object.assign(new Error("context service unavailable"), { status: 500 });
    const provider = new OpenAIResponsesProvider({
      credentials: {
        client: async () =>
          ({ responses: { create: async () => Promise.reject(error) } }) as unknown as OpenAI,
      },
    });

    await expect(
      consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toBe(error);
  });
});
