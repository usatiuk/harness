import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/protocol";
import { ROSTER, DEFAULT_FAMILY, familyOf, maxOutputOf, listModels } from "./roster.ts";
import { OpenCodeGoProvider } from "./provider.ts";

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "opencode-go", model: "deepseek-v4-pro" },
};

const neverCredentials = () => async () => ({}) as never;

function provider() {
  return new OpenCodeGoProvider({
    openai: { client: neverCredentials() },
    anthropic: { client: neverCredentials() },
  });
}

describe("roster", () => {
  it("covers every live gateway model", () => {
    // The gateway's live /v1/models (verified 2026-08-08) lists 25 ids.
    const live = [
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.7-max",
      "qwen3.8-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "hy3",
      "hy3-preview",
      "gpt-5.6-luna",
      "grok-4.5",
    ];
    expect(new Set(ROSTER.map((m) => m.model))).toEqual(new Set(live));
  });

  it("assigns each model its gateway family", () => {
    expect(familyOf("gpt-5.6-luna")).toBe("responses");
    expect(familyOf("grok-4.5")).toBe("responses");
    expect(familyOf("minimax-m3")).toBe("messages");
    expect(familyOf("qwen3.7-max")).toBe("messages");
    expect(familyOf("deepseek-v4-pro")).toBe("chat");
    expect(familyOf("glm-5.2")).toBe("chat");
    expect(familyOf("hy3-preview")).toBe("chat");
  });

  it("defaults unknown ids to the chat family with no limits", () => {
    expect(familyOf("brand-new-model")).toBe(DEFAULT_FAMILY);
    expect(maxOutputOf("brand-new-model")).toBeUndefined();
  });

  it("lists sized models under the provider id", () => {
    const models = listModels("opencode-go");
    expect(models).toHaveLength(ROSTER.length);
    expect(models.every((m) => m.provider === "opencode-go")).toBe(true);
    expect(models.find((m) => m.model === "gpt-5.6-luna")).toEqual({
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });
});

describe("OpenCodeGoProvider", () => {
  it("exposes one registry id and the roster", () => {
    const p = provider();
    expect(p.provider).toBe("opencode-go");
    expect(p.listModels()).toHaveLength(ROSTER.length);
  });

  it("selects the fileTools profile per family", () => {
    const p = provider();
    expect(p.capabilities("gpt-5.6-luna").fileTools).toBe("apply_patch");
    expect(p.capabilities("minimax-m3").fileTools).toBe("text_editor");
    expect(p.capabilities("deepseek-v4-pro").fileTools).toBe("string_replace");
    expect(p.capabilities("unknown-model").fileTools).toBe("string_replace");
  });

  it("rejects a preset rather than ignoring it", () => {
    const p = provider();
    expect(() =>
      p.validateConfig({ provider: "opencode-go", model: "hy3", preset: "high" }),
    ).toThrow(/no presets/);
    expect(() => p.validateConfig({ provider: "opencode-go", model: "hy3" })).not.toThrow();
  });

  it("streams a chat-family model through the chat transport", async () => {
    let called = "";
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            chat: {
              completions: {
                create: async () => {
                  called = "chat";
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] };
                    },
                  };
                },
              },
            },
            responses: { create: async () => Promise.reject(new Error("wrong transport")) },
          }) as never,
      },
      anthropic: { client: neverCredentials() },
    });

    const events: string[] = [];
    for await (const e of p.stream(REQUEST, new AbortController().signal)) events.push(e.type);
    expect(called).toBe("chat");
    expect(events).toEqual(["text_delta", "completed"]);
  });

  it("streams a responses-family model through the responses transport", async () => {
    let called = "";
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            chat: {
              completions: { create: async () => Promise.reject(new Error("wrong transport")) },
            },
            responses: {
              create: async () => {
                called = "responses";
                return {
                  async *[Symbol.asyncIterator]() {
                    yield {
                      type: "response.completed",
                      response: { usage: { input_tokens: 1, output_tokens: 1 } },
                    };
                  },
                };
              },
            },
          }) as never,
      },
      anthropic: { client: neverCredentials() },
    });

    for await (const _ of p.stream(
      { ...REQUEST, modelConfig: { provider: "opencode-go", model: "gpt-5.6-luna" } },
      new AbortController().signal,
    )) {
      void _;
    }
    expect(called).toBe("responses");
  });

  it("streams a messages-family model through the messages transport with roster maxTokens", async () => {
    let params: { max_tokens?: number } | undefined;
    const p = new OpenCodeGoProvider({
      openai: { client: neverCredentials() },
      anthropic: {
        client: async () =>
          ({
            messages: {
              create: async (value: { max_tokens?: number }) => {
                params = value;
                return {
                  async *[Symbol.asyncIterator]() {
                    yield {
                      type: "message_start",
                      message: { usage: { input_tokens: 5, output_tokens: 1 } },
                    };
                    yield {
                      type: "message_delta",
                      delta: { stop_reason: "end_turn" },
                      usage: { output_tokens: 5 },
                    };
                    yield { type: "message_stop" };
                  },
                };
              },
            },
          }) as never,
      },
    });

    const events: string[] = [];
    for await (const e of p.stream(
      { ...REQUEST, modelConfig: { provider: "opencode-go", model: "minimax-m3" } },
      new AbortController().signal,
    )) {
      events.push(e.type);
    }
    // minimax-m3 maxOut is 131072; the Messages subclass must not fall back to 8192.
    expect(params?.max_tokens).toBe(131_072);
    // And it must not add thinking/effort machinery Go's messages models don't serve.
    expect(params).toEqual({
      model: "minimax-m3",
      max_tokens: 131_072,
      messages: [],
      stream: true,
    });
    expect(events).toEqual(["completed"]);
  });
});
