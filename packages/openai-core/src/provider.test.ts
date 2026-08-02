import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { ContextWindowExceededError, type ModelRequest } from "@harness/protocol";
import { OpenAIResponsesProvider, reasoningForSelection } from "./provider.ts";

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
  it("uses the chosen effort when the model offers it, keeping other base fields", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1", effort: "high" }, BASE);
    expect(r).toEqual({ effort: "high", summary: "auto" });
  });

  it("falls back to the model default when effort is absent", () => {
    const r = reasoningForSelection({ provider: "openai", model: "gpt-5.1" }, BASE);
    expect(r.effort).toBe("medium");
  });

  it("falls back to the model default when effort is not offered", () => {
    // codex does not offer `none`
    const r = reasoningForSelection(
      { provider: "openai", model: "gpt-5.1-codex", effort: "none" },
      BASE,
    );
    expect(r.effort).toBe("medium");
  });

  it("leaves base untouched for an unknown model", () => {
    const r = reasoningForSelection({ provider: "openai", model: "mystery", effort: "high" }, BASE);
    expect(r).toBe(BASE);
  });
});

describe("listModels", () => {
  it("declares per-model efforts and a default", () => {
    const provider = new OpenAIResponsesProvider({
      credentials: { client: async () => ({}) as never },
    });
    const models = provider.listModels();
    const gpt = models.find((m) => m.model === "gpt-5.1");
    expect(gpt?.defaultEffort).toBe("medium");
    expect(gpt?.efforts?.map((e) => e.value)).toEqual(["none", "low", "medium", "high"]);
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
      consume(provider.stream(REQUEST, new AbortController().signal)),
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

    await expect(consume(provider.stream(REQUEST, new AbortController().signal))).rejects.toBe(
      error,
    );
  });
});
