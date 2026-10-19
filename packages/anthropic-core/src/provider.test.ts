import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ContextWindowExceededError, type ModelRequest } from "@harness/protocol";
import { AnthropicProvider } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "anthropic", model: "claude-sonnet-4-6" },
};

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event;
}

describe("AnthropicProvider context overflow normalization", () => {
  it("sends an invocation output cap instead of the direct catalog default", async () => {
    let params: Anthropic.Messages.MessageCreateParamsStreaming | undefined;
    const reached = new Error("Reached SDK boundary");
    const provider = new AnthropicProvider({
      credentials: {
        client: async () =>
          ({
            messages: {
              create: async (value: Anthropic.Messages.MessageCreateParamsStreaming) => {
                params = value;
                throw reached;
              },
            },
          }) as unknown as Anthropic,
      },
    });
    await expect(
      consume(
        provider.stream(
          { ...REQUEST, maxOutputTokens: 4096 },
          new AbortController().signal,
          CALL_CONTEXT,
        ),
      ),
    ).rejects.toBe(reached);
    expect(params?.max_tokens).toBe(4096);
    expect(
      provider.listModels().find(({ model }) => model === REQUEST.modelConfig.model)
        ?.maxOutputTokens,
    ).toBe(64000);
  });
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
      consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toBeInstanceOf(ContextWindowExceededError);
  });

  it("classifies unrelated 5xx provider failures as transient without normalizing them", async () => {
    const error = Object.assign(new Error("context service unavailable"), { status: 500 });
    const provider = new AnthropicProvider({
      credentials: {
        client: async () =>
          ({ messages: { create: async () => Promise.reject(error) } }) as unknown as Anthropic,
      },
    });

    await expect(
      consume(provider.stream(REQUEST, new AbortController().signal, CALL_CONTEXT)),
    ).rejects.toMatchObject({ name: "TransientModelFailure", cause: error });
  });
});

describe("Anthropic image capability metadata", () => {
  it("declares documented image support for the maintained roster without network discovery", () => {
    const provider = new AnthropicProvider({
      credentials: {
        client: async () => {
          throw new Error("No catalog network request is needed");
        },
      },
    });
    expect(
      provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
    ).toEqual([
      { model: "claude-opus-4-8", supportsImages: true },
      { model: "claude-sonnet-4-6", supportsImages: true },
      { model: "claude-haiku-4-5", supportsImages: true },
    ]);
  });
});

it("adds manual models and overrides existing metadata", () => {
  const provider = new AnthropicProvider({
    credentials: { client: async () => ({}) as never },
    modelOverrides: {
      manual: { label: "Manual", preferredEditTool: "patch" },
      "claude-sonnet-4-6": { maxOutputTokens: 8192 },
    },
  });
  expect(provider.listModels().find((entry) => entry.model === "manual")).toEqual({
    provider: "anthropic",
    model: "manual",
    label: "Manual",
    preferredEditTool: "patch",
  });
  expect(provider.capabilities("manual")).toMatchObject({
    preferredEditTool: "patch",
    customToolInput: { supported: false, grammars: [] },
  });
  expect(
    provider.listModels().find((entry) => entry.model === "claude-sonnet-4-6")?.maxOutputTokens,
  ).toBe(8192);
});

describe("configured native model controls", () => {
  it("advertises, validates, and sends configured thinking and effort for a manually added model", async () => {
    let params: Anthropic.Messages.MessageCreateParamsStreaming | undefined;
    const reached = new Error("Reached SDK boundary");
    const provider = new AnthropicProvider({
      modelOverrides: {
        "manual-model": {
          presets: ["low", "high"],
          defaultPreset: "low",
          thinking: { type: "adaptive", display: "summarized" },
        },
        "claude-sonnet-4-6": {
          presets: ["low"],
          defaultPreset: "low",
          thinking: { type: "disabled" },
        },
      },
      credentials: {
        client: async () =>
          ({
            messages: {
              create: async (value: Anthropic.Messages.MessageCreateParamsStreaming) => {
                params = value;
                throw reached;
              },
            },
          }) as unknown as Anthropic,
      },
    });
    const manual = provider.listModels().find(({ model }) => model === "manual-model");
    expect(manual).toMatchObject({
      presets: [{ value: "low" }, { value: "high" }],
      defaultPreset: "low",
    });
    expect(manual?.contextWindow).toBeUndefined();
    expect(() =>
      provider.validateConfig({ provider: "anthropic", model: "manual-model", preset: "medium" }),
    ).toThrow("unknown preset");
    for (const model of ["manual-model", "claude-sonnet-4-6"]) {
      await expect(
        consume(
          provider.stream(
            { ...REQUEST, modelConfig: { provider: "anthropic", model } },
            new AbortController().signal,
            CALL_CONTEXT,
          ),
        ),
      ).rejects.toBe(reached);
      expect(params?.output_config?.effort).toBe("low");
      expect(params?.thinking).toEqual(
        model === "manual-model"
          ? { type: "adaptive", display: "summarized" }
          : { type: "disabled" },
      );
    }
  });
});

it("clears inherited default effort when configured presets replace its choices", () => {
  for (const presets of [[], ["low"] as const]) {
    const provider = new AnthropicProvider({
      credentials: {
        client: async () => {
          throw new Error("unused");
        },
      },
      modelOverrides: { "claude-sonnet-4-6": { presets: [...presets] } },
    });
    const model = provider.listModels().find((entry) => entry.model === "claude-sonnet-4-6")!;
    expect(model.presets).toEqual(presets.map((value) => ({ value })));
    expect(model.defaultPreset).toBeUndefined();
  }
});
