import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/protocol";
import { ROSTER, familyOf, maxOutputOf, listModels } from "./roster.ts";
import { OpenCodeGoProvider } from "./provider.ts";
import type { ModelCallContext } from "@harness/protocol";

const CALL_CONTEXT = { conversationId: "test-conversation" } as ModelCallContext;

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
  it("bundles current supported Models.dev entries and excludes unavailable transports", () => {
    expect(ROSTER).toHaveLength(28);
    expect(ROSTER.map((model) => model.model)).toContain("gpt-6-luna");
    expect(ROSTER.map((model) => model.model)).not.toContain("step-5-preview-free");
    expect(ROSTER.map((model) => model.model)).not.toContain("minimax-m2.7");
    expect(ROSTER.map((model) => model.model)).not.toContain("gemini-4-argon-contributor");
  });

  it("assigns each model its gateway family", () => {
    expect(familyOf("gpt-5.6-luna")).toBe("responses");
    expect(familyOf("muse-spark-1.3-contributor")).toBe("responses");
    expect(familyOf("grok-4.7")).toBe("responses");
    expect(familyOf("minimax-m3")).toBe("messages");
    expect(familyOf("qwen3.8-max")).toBe("messages");
    expect(familyOf("deepseek-v4-pro")).toBe("chat");
    expect(familyOf("glm-5.2")).toBe("chat");
    expect(familyOf("hy4-preview")).toBe("chat");
  });

  it("leaves unknown ids unclassified with no limits", () => {
    expect(familyOf("brand-new-model")).toBeUndefined();
    expect(maxOutputOf("brand-new-model")).toBeUndefined();
  });

  it("lists sized models under the provider id", () => {
    const models = listModels("opencode-go");
    expect(models).toHaveLength(ROSTER.length);
    expect(models.every((m) => m.provider === "opencode-go")).toBe(true);
    expect(models.find((m) => m.model === "gpt-5.6-luna")).toMatchObject({
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

  it("exposes advertised efforts and preserves qualified Messages controls", () => {
    const models = listModels("opencode-go");
    expect(
      models.find((model) => model.model === "grok-4.7")?.presets?.map((p) => p.value),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      models.find((model) => model.model === "qwen3.8-max")?.presets?.map((p) => p.value),
    ).toEqual(["high", "max"]);
    expect(
      models.find((model) => model.model === "minimax-m3")?.presets?.map((p) => p.value),
    ).toEqual(["none", "thinking"]);
    expect(models.find((model) => model.model === "mimo-v2.5")?.presets).toBeUndefined();
  });
});

describe("OpenCodeGoProvider", () => {
  it("exposes one registry id and the roster", () => {
    const p = provider();
    expect(p.provider).toBe("opencode-go");
    expect(p.listModels()).toHaveLength(ROSTER.length);
  });

  it("keeps editing preference independent of transport support", () => {
    const p = provider();
    expect(p.capabilities("gpt-5.6-luna").preferredEditTool).toBe("patch");
    expect(p.capabilities("grok-4.7").preferredEditTool).toBe("replace");
    expect(p.capabilities("minimax-m3").preferredEditTool).toBe("replace");
    expect(p.capabilities("deepseek-v4-pro").preferredEditTool).toBe("replace");
    expect(p.capabilities("gpt-5.6-luna").customToolInput).toEqual({
      supported: false,
      grammars: [],
    });
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
      p.validateConfig({ provider: "opencode-go", model: "mimo-v2.5", preset: "high" }),
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
    for await (const e of p.stream(REQUEST, new AbortController().signal, CALL_CONTEXT))
      events.push(e.type);
    expect(called).toBe("chat");
    expect(params?.reasoning_effort).toBeUndefined();
    expect(events).toEqual(["text_delta", "message", "completed"]);
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
        modelConfig: { provider: "opencode-go", model: "deepseek-v4.1-flash", preset: "max" },
      },
      new AbortController().signal,
      CALL_CONTEXT,
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
      CALL_CONTEXT,
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
      CALL_CONTEXT,
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
      CALL_CONTEXT,
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
        CALL_CONTEXT,
      )) {
        void _;
      }
      expect(params?.thinking).toEqual(expected);
    },
  );
});

it("adds manually routed models without inventing limits", () => {
  const p = new OpenCodeGoProvider({
    openai: { client: neverCredentials() },
    anthropic: { client: neverCredentials() },
    models: {
      manual: {
        transport: "responses",
        label: "Manual",
        preferredEditTool: "patch",
        customToolInput: { supported: true, grammars: [] },
      },
      "gpt-5.6-luna": { preferredEditTool: "replace" },
    },
  });
  expect(p.listModels().find((entry) => entry.model === "manual")).toMatchObject({
    provider: "opencode-go",
    model: "manual",
    label: "Manual",
  });
  expect(p.listModels().find((entry) => entry.model === "manual")?.contextWindow).toBeUndefined();
  expect(p.capabilities("manual")).toMatchObject({
    preferredEditTool: "patch",
    customToolInput: { supported: true, grammars: [] },
  });
  expect(p.capabilities("gpt-5.6-luna").preferredEditTool).toBe("replace");
  expect(p.capabilities("muse-spark-1.3-contributor").customToolInput.supported).toBe(false);
  expect(() => p.validateConfig({ provider: p.provider, model: "manual" })).not.toThrow();
});

it.each(["chat", "responses", "messages"] as const)(
  "delivers a manually configured %s preset",
  async (transport) => {
    let params: Record<string, unknown> | undefined;
    const create = async (value: Record<string, unknown>) => {
      params = value;
      return {
        async *[Symbol.asyncIterator]() {
          if (transport === "responses") yield { type: "response.completed", response: {} };
          else if (transport === "messages") {
            yield {
              type: "message_start",
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            };
            yield { type: "message_stop" };
          } else yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        },
      };
    };
    const p = new OpenCodeGoProvider({
      openai: {
        client: async () => ({ responses: { create }, chat: { completions: { create } } }) as never,
      },
      anthropic: { client: async () => ({ messages: { create } }) as never },
      models: {
        manual: {
          transport,
          presets: [
            {
              value: "custom",
              control:
                transport === "messages"
                  ? { kind: "thinking", thinking: "adaptive" }
                  : { kind: "effort", effort: "high" },
            },
          ],
          defaultPreset: "custom",
        },
      },
    });
    expect(p.listModels().find((entry) => entry.model === "manual")).toMatchObject({
      presets: [{ value: "custom" }],
      defaultPreset: "custom",
    });
    const req = { ...REQUEST, modelConfig: { provider: p.provider, model: "manual" } };
    p.validateConfig(req.modelConfig);
    for await (const event of p.stream(req, new AbortController().signal, CALL_CONTEXT)) void event;
    expect(params).toMatchObject(
      transport === "chat"
        ? { reasoning_effort: "high" }
        : transport === "responses"
          ? { reasoning: { effort: "high" } }
          : { thinking: { type: "adaptive" } },
    );
  },
);

it("rejects configured controls incompatible with the resolved transport", () => {
  expect(
    () =>
      new OpenCodeGoProvider({
        openai: { client: neverCredentials() },
        anthropic: { client: neverCredentials() },
        models: {
          manual: {
            transport: "messages",
            presets: [{ value: "high", control: { kind: "effort", effort: "high" } }],
          },
        },
      }),
  ).toThrow("incompatible");
});

it("validates native model control configuration", async () => {
  const { openCodeGoProviderType } = await import("./provider-type.ts");
  expect(() =>
    openCodeGoProviderType.prepare({
      models: {
        manual: {
          transport: "messages",
          presets: [{ value: "think", control: { kind: "thinking-budget", budgetTokens: 4096 } }],
        },
      },
    }),
  ).not.toThrow();
  expect(() =>
    openCodeGoProviderType.prepare({
      models: {
        manual: {
          presets: [{ value: "think", control: { kind: "thinking-budget", budgetTokens: 0 } }],
        },
      },
    }),
  ).toThrow();
});

it("clears inherited defaults when configured presets are emptied", () => {
  const p = new OpenCodeGoProvider({
    openai: { client: neverCredentials() },
    anthropic: { client: neverCredentials() },
    models: { "gpt-5.6-luna": { presets: [] } },
  });
  const model = p.listModels().find((entry) => entry.model === "gpt-5.6-luna")!;
  expect(model.presets).toEqual([]);
  expect(model.defaultPreset).toBeUndefined();
});
