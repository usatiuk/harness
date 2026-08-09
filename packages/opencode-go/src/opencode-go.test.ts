import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/protocol";
import { ROSTER, familyOf, maxOutputOf, listModels } from "./roster.ts";
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
  it("matches the verified gateway model snapshot", () => {
    // The gateway's /v1/models snapshot verified 2026-08-08 lists 25 ids.
    const snapshot = [
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
    expect(new Set(ROSTER.map((m) => m.model))).toEqual(new Set(snapshot));
  });

  it("assigns each model its gateway family", () => {
    expect(familyOf("gpt-5.6-luna")).toBe("responses");
    expect(familyOf("grok-4.5")).toBe("chat");
    expect(familyOf("minimax-m3")).toBe("messages");
    expect(familyOf("qwen3.7-max")).toBe("messages");
    expect(familyOf("deepseek-v4-pro")).toBe("chat");
    expect(familyOf("glm-5.2")).toBe("chat");
    expect(familyOf("hy3-preview")).toBe("chat");
  });

  it("leaves unknown ids unclassified with no limits", () => {
    expect(familyOf("brand-new-model")).toBeUndefined();
    expect(maxOutputOf("brand-new-model")).toBeUndefined();
  });

  it("lists sized models under the provider id", () => {
    const models = listModels("opencode-go");
    expect(models).toHaveLength(ROSTER.length);
    expect(models.every((m) => m.provider === "opencode-go")).toBe(true);
    expect(models.find((m) => m.model === "gpt-5.6-luna")).toEqual({
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      presets: [
        { value: "none" },
        { value: "low" },
        { value: "medium" },
        { value: "high" },
        { value: "xhigh" },
        { value: "max" },
      ],
      defaultPreset: "medium",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });

  it("exposes only the model-scoped presets advertised by the verified catalog", () => {
    const offered = Object.fromEntries(
      listModels("opencode-go")
        .filter((model) => model.presets?.length)
        .map((model) => [model.model, model.presets?.map((preset) => preset.value)]),
    );
    expect(offered).toEqual({
      "grok-4.5": ["low", "medium", "high"],
      "glm-5.2": ["high", "max"],
      "kimi-k3": ["max"],
      "deepseek-v4-pro": ["high", "max"],
      "deepseek-v4-flash": ["low", "high", "max"],
      hy3: ["none", "low", "high"],
      "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
      "minimax-m3": ["none", "thinking"],
      "qwen3.8-max": ["high", "max"],
      "qwen3.7-max": ["high", "max"],
      "qwen3.7-plus": ["high", "max"],
      "qwen3.6-plus": ["high", "max"],
      "qwen3.5-plus": ["high", "max"],
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
    expect(p.capabilities("grok-4.5").fileTools).toBe("string_replace");
    expect(p.capabilities("minimax-m3").fileTools).toBe("text_editor");
    expect(p.capabilities("deepseek-v4-pro").fileTools).toBe("string_replace");
    expect(() => p.capabilities("unknown-model")).toThrow(/unknown model/);
  });

  it("accepts only presets offered by the exact model", () => {
    const p = provider();
    expect(() =>
      p.validateConfig({ provider: "opencode-go", model: "hy3", preset: "high" }),
    ).not.toThrow();
    expect(() =>
      p.validateConfig({ provider: "opencode-go", model: "hy3", preset: "max" }),
    ).toThrow(/unknown preset.*try: none, low, high/);
    expect(() =>
      p.validateConfig({ provider: "opencode-go", model: "glm-5.1", preset: "high" }),
    ).toThrow(/has no presets/);
    expect(() => p.validateConfig({ provider: "opencode-go", model: "hy3" })).not.toThrow();
    expect(() => p.validateConfig({ provider: "opencode-go", model: "unknown-model" })).toThrow(
      /unknown model/,
    );
  });

  it("streams a chat-family model through the chat transport", async () => {
    let called = "";
    let params: { reasoning_effort?: string } | undefined;
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            chat: {
              completions: {
                create: async (value: { reasoning_effort?: string }) => {
                  called = "chat";
                  params = value;
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
    expect(params?.reasoning_effort).toBeUndefined();
    expect(events).toEqual(["text_delta", "completed"]);
  });

  it("maps a selected chat preset to reasoning_effort", async () => {
    let params: { reasoning_effort?: string } | undefined;
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            chat: {
              completions: {
                create: async (value: { reasoning_effort?: string }) => {
                  params = value;
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
                    },
                  };
                },
              },
            },
          }) as never,
      },
      anthropic: { client: neverCredentials() },
    });

    for await (const _ of p.stream(
      {
        ...REQUEST,
        modelConfig: { provider: "opencode-go", model: "deepseek-v4-flash", preset: "max" },
      },
      new AbortController().signal,
    )) {
      void _;
    }
    expect(params?.reasoning_effort).toBe("max");
  });

  it("streams a responses-family model through the responses transport", async () => {
    let called = "";
    let params:
      | { include?: string[]; store?: boolean; reasoning?: { effort?: string; summary?: string } }
      | undefined;
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            chat: {
              completions: { create: async () => Promise.reject(new Error("wrong transport")) },
            },
            responses: {
              create: async (value: {
                include?: string[];
                store?: boolean;
                reasoning?: { effort?: string; summary?: string };
              }) => {
                called = "responses";
                params = value;
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
    expect(params).toMatchObject({
      include: ["reasoning.encrypted_content"],
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
    });
  });

  it("maps a selected Luna preset while retaining reasoning summaries", async () => {
    let params: { reasoning?: { effort?: string; summary?: string } } | undefined;
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () =>
          ({
            responses: {
              create: async (value: { reasoning?: { effort?: string; summary?: string } }) => {
                params = value;
                return {
                  async *[Symbol.asyncIterator]() {
                    yield { type: "response.completed", response: {} };
                  },
                };
              },
            },
          }) as never,
      },
      anthropic: { client: neverCredentials() },
    });

    for await (const _ of p.stream(
      {
        ...REQUEST,
        modelConfig: { provider: "opencode-go", model: "gpt-5.6-luna", preset: "max" },
      },
      new AbortController().signal,
    )) {
      void _;
    }
    expect(params?.reasoning).toEqual({ effort: "max", summary: "auto" });
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
    // The provider-default/no-preset selection must not add thinking machinery.
    expect(params).toEqual({
      model: "minimax-m3",
      max_tokens: 131_072,
      messages: [],
      stream: true,
    });
    expect(events).toEqual(["completed"]);
  });

  it.each([
    {
      model: "minimax-m3",
      preset: "none",
      cap: undefined,
      expected: { type: "disabled" },
    },
    {
      model: "minimax-m3",
      preset: "thinking",
      cap: undefined,
      expected: { type: "adaptive" },
    },
    {
      model: "qwen3.8-max",
      preset: "high",
      cap: undefined,
      expected: { type: "enabled", budget_tokens: 16_000 },
    },
    {
      model: "qwen3.8-max",
      preset: "max",
      cap: undefined,
      expected: { type: "enabled", budget_tokens: 31_999 },
    },
    {
      model: "qwen3.8-max",
      preset: "max",
      cap: 4096,
      expected: { type: "enabled", budget_tokens: 4095 },
    },
  ])(
    "maps $model/$preset to the compiled Messages thinking control",
    async ({ model, preset, cap, expected }) => {
      let params: { thinking?: unknown } | undefined;
      const p = new OpenCodeGoProvider({
        openai: { client: neverCredentials() },
        anthropic: {
          client: async () =>
            ({
              messages: {
                create: async (value: { thinking?: unknown }) => {
                  params = value;
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield {
                        type: "message_start",
                        message: { usage: { input_tokens: 1, output_tokens: 0 } },
                      };
                      yield {
                        type: "message_delta",
                        delta: { stop_reason: "end_turn" },
                        usage: { output_tokens: 1 },
                      };
                      yield { type: "message_stop" };
                    },
                  };
                },
              },
            }) as never,
        },
      });

      for await (const _ of p.stream(
        {
          ...REQUEST,
          modelConfig: { provider: "opencode-go", model, preset },
          ...(cap ? { maxOutputTokens: cap } : {}),
        },
        new AbortController().signal,
      )) {
        void _;
      }
      expect(params?.thinking).toEqual(expected);
    },
  );
});
