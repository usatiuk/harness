import { afterEach, describe, expect, it, vi } from "vitest";
import { TransientModelFailure } from "@harness/protocol";
import type { ConversationId, ModelRequest } from "@harness/protocol";
import { CustomOpenAIProvider } from "./custom-openai.ts";
import { CustomOpenAICompletionsProvider } from "./custom-openai-completions.ts";
import { CustomAnthropicProvider } from "./custom-anthropic.ts";
import { configuredProvider, configuredProviders } from "./provider-fixture.ts";

// `buildParams` (OpenAI) and `buildConfig` (Anthropic) are overrides of protected seams, so tests
// widen the subclass with their signatures rather than going through a live provider stream.
type OpenAIExposed = { buildParams(request: ModelRequest): Record<string, unknown> };
type AnthropicExposed = { buildConfig(request: ModelRequest): Record<string, unknown> };

const REQUEST: ModelRequest = {
  instructions: [],
  items: [],
  modelConfig: { provider: "local", model: "my-model" },
};

describe("CustomOpenAIProvider catalog", () => {
  it("declares one sized model with a preset axis per model entry", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        "my-model": { contextWindow: 32_768, maxOutputTokens: 4096, presets: { fast: {} } },
      },
    });

    expect(provider.listModels()).toEqual([
      {
        provider: "local",
        model: "my-model",
        presets: [{ value: "fast" }],
        contextWindow: 32_768,
        maxOutputTokens: 4096,
      },
    ]);
  });

  it("lists every model served by one endpoint with its own limits and presets", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        big: { contextWindow: 131_072, maxOutputTokens: 8192, presets: { high: {} } },
        small: {},
      },
    });

    expect(provider.listModels()).toEqual([
      {
        provider: "local",
        model: "big",
        presets: [{ value: "high" }],
        contextWindow: 131_072,
        maxOutputTokens: 8192,
      },
      { provider: "local", model: "small", presets: [] },
    ]);
  });

  it("leaves limits and presets off the catalog when unset", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });

    expect(provider.listModels()).toEqual([{ provider: "local", model: "my-model", presets: [] }]);
  });

  it("selects per-model editing preference with conservative input defaults", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { patched: { preferredEditTool: "patch" }, plain: {} },
    });

    expect(provider.capabilities("patched").preferredEditTool).toBe("patch");
    expect(provider.capabilities("plain")).toMatchObject({
      preferredEditTool: "replace",
      customToolInput: { supported: false, grammars: [] },
    });
    expect(() => provider.capabilities("unknown")).toThrow(/unknown model/);
  });
});

describe("CustomOpenAIProvider.validateConfig", () => {
  it("rejects a model the provider does not serve", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });

    expect(() => provider.validateConfig({ provider: "local", model: "other-model" })).toThrow(
      /unknown model "other-model" for provider local/,
    );
  });

  it("rejects a preset the chosen model does not define", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": { presets: { fast: {} } } },
    });

    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "nope" }),
    ).toThrow(/unknown preset "nope"/);
  });

  it("does not accept prototype properties as configured preset names", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });
    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "constructor" }),
    ).toThrow(/unknown preset/);
  });

  it("scopes preset validation to the chosen model", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        withPresets: { presets: { fast: {} } },
        bare: {},
      },
    });

    expect(() =>
      provider.validateConfig({ provider: "local", model: "withPresets", preset: "fast" }),
    ).not.toThrow();
    expect(() =>
      provider.validateConfig({ provider: "local", model: "bare", preset: "fast" }),
    ).toThrow(/unknown preset "fast"/);
    expect(() => provider.validateConfig({ provider: "local", model: "bare" })).not.toThrow();
  });
});

describe("CustomOpenAIProvider request shaping", () => {
  it("drops the reasoning field and applies the chosen model's selected preset", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        "my-model": {
          presets: {
            fast: { temperature: 0.2, topP: 0.9, maxTokens: 2048, extraBody: { seed: 42 } },
          },
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widen the protected method
    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      modelConfig: { provider: "local", model: "my-model", preset: "fast" },
    }) as Record<string, unknown>;

    expect(params).not.toHaveProperty("reasoning");
    expect(params).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 2048,
      seed: 42,
    });
  });

  it("keeps instructions in the top-level field by default", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });

    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      instructions: [{ type: "text", text: "You are terse." }],
    }) as { instructions?: unknown; input: unknown[] };

    expect(params.instructions).toBe("You are terse.");
  });

  it("renders instructions as a leading system message when opted in", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
      sendInstructionsAsSystem: true,
    });

    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      instructions: [{ type: "text", text: "you must say YES" }],
    });

    expect(params).not.toHaveProperty("instructions");
    expect(params.input).toEqual([{ role: "system", content: "you must say YES" }]);
  });

  it("leaves the base request alone when no preset is chosen", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });

    const params = (provider as unknown as OpenAIExposed).buildParams(REQUEST);

    expect(params).not.toHaveProperty("reasoning");
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
  });

  it("keeps an invocation output cap more specific than the selected preset", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": { presets: { long: { maxTokens: 8192, temperature: 0.2 } } } },
    });
    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      maxOutputTokens: 1000,
      modelConfig: { provider: "local", model: "my-model", preset: "long" },
    });
    expect(params.max_output_tokens).toBe(1000);
    expect(params.temperature).toBe(0.2);
  });

  it("applies a preset keyed to the chosen model only", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        "my-model": { presets: { fast: { temperature: 0.1 } } },
        "other-model": {},
      },
    });

    const shaped = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      modelConfig: { provider: "local", model: "other-model", preset: "fast" },
    });

    expect(shaped.temperature).toBeUndefined();
  });
});

describe("CustomAnthropicProvider", () => {
  it("lists a sized model with the configured preset axis", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        "my-model": { contextWindow: 64_000, maxOutputTokens: 4096, presets: { long: {} } },
      },
    });

    expect(provider.listModels()).toEqual([
      {
        provider: "local",
        model: "my-model",
        presets: [{ value: "long" }],
        contextWindow: 64_000,
        maxOutputTokens: 4096,
      },
    ]);
  });

  it("drops thinking/effort and applies the chosen model's preset, tunneling extras through extra_body", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        "my-model": {
          presets: {
            creative: { temperature: 1.1, maxTokens: 4096, topK: 40, extraBody: { seed: 7 } },
          },
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widen the protected method
    const config = (provider as unknown as AnthropicExposed).buildConfig({
      ...REQUEST,
      modelConfig: { provider: "local", model: "my-model", preset: "creative" },
    }) as Record<string, unknown>;

    expect(config.thinking).toBeUndefined();
    expect(config.effort).toBeUndefined();
    expect(config).toMatchObject({ temperature: 1.1, maxTokens: 4096 });
    expect(config.extraBody).toMatchObject({ top_k: 40, seed: 7 });
  });

  it("defaults the request cap from the chosen model's maxOutputTokens, not the built-in fallback", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: { "my-model": { maxOutputTokens: 65_536 } },
    });

    const config = (provider as unknown as AnthropicExposed).buildConfig(REQUEST);

    expect(config.maxTokens).toBe(65_536);
  });

  it("lets a preset maxTokens override the configured cap", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        "my-model": { maxOutputTokens: 65_536, presets: { short: { maxTokens: 8192 } } },
      },
    });

    const config = (provider as unknown as AnthropicExposed).buildConfig({
      ...REQUEST,
      modelConfig: { provider: "local", model: "my-model", preset: "short" },
    });

    expect(config.maxTokens).toBe(8192);
  });

  it("applies a preset only to the model that defines it", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        "my-model": { presets: { creative: { temperature: 1.1 } } },
        "other-model": {},
      },
    });

    const config = (provider as unknown as AnthropicExposed).buildConfig({
      ...REQUEST,
      modelConfig: { provider: "local", model: "other-model", preset: "creative" },
    });

    expect(config.temperature).toBeUndefined();
  });

  it("supports JSON patch preference independently of the Messages transport", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        patched: { preferredEditTool: "patch" },
        plain: {},
      },
    });

    expect(provider.capabilities("patched").preferredEditTool).toBe("patch");
    expect(provider.capabilities("plain")).toMatchObject({
      preferredEditTool: "replace",
      customToolInput: { supported: false, grammars: [] },
    });
    expect(() => provider.capabilities("unknown")).toThrow(/unknown model/);
  });

  it("rejects an unknown model and an unknown preset for a known one", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: { "my-model": { presets: { long: {} } } },
    });

    expect(() => provider.validateConfig({ provider: "local", model: "other" })).toThrow(
      /unknown model "other"/,
    );
    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "unset" }),
    ).toThrow(/unknown preset "unset"/);
  });
});

describe("configured provider types", () => {
  it.each(["openai-responses-compatible", "openai-completions-compatible", "anthropic-compatible"])(
    "constructs %s with its configured identity and catalog",
    async (type) => {
      const provider = await configuredProvider("local", type, {
        endpoint: "http://localhost:8000/v1",
        apiKey: "dummy",
        models: { coding: { presets: { fast: { temperature: 0.2 } } } },
      });
      expect(provider.provider).toBe("local");
      expect(provider.listModels()).toEqual([
        { provider: "local", model: "coding", presets: [{ value: "fast" }] },
      ]);
    },
  );
  it.each(["openai-responses-compatible", "openai-completions-compatible", "anthropic-compatible"])(
    "keeps %s model identity separate from its readable label",
    async (type) => {
      const model = "tinker://checkpoint/sampler_weights/model";
      const provider = await configuredProvider("local", type, {
        endpoint: "http://localhost:8000/v1",
        apiKey: "dummy",
        models: { [model]: { label: "Qwen 27B · Investigation test", contextWindow: 262144 } },
      });
      expect(provider.listModels()).toEqual([
        {
          provider: "local",
          model,
          label: "Qwen 27B · Investigation test",
          contextWindow: 262144,
          presets: [],
        },
      ]);
      expect(() => provider.validateConfig({ provider: "local", model })).not.toThrow();
      expect(() =>
        provider.validateConfig({ provider: "local", model: "Qwen 27B · Investigation test" }),
      ).toThrow(/unknown model/);
    },
  );
  it("constructs several configured types through the same instance boundary", async () => {
    const providers = await configuredProviders({
      providers: {
        a: {
          type: "openai-responses-compatible",
          config: { endpoint: "http://a", apiKey: "k", models: { m1: {} } },
        },
        b: {
          type: "anthropic-compatible",
          config: { endpoint: "http://b", apiKey: "k", models: { m2: {} } },
        },
        c: {
          type: "openai-completions-compatible",
          config: { endpoint: "http://c", apiKey: "k", models: { m3: {} } },
        },
      },
    });
    expect(providers.map((provider) => provider.provider)).toEqual(["a", "b", "c"]);
  });
});

describe("CustomOpenAICompletionsProvider", () => {
  it("lists a sized model with a preset axis and function-only capabilities", () => {
    const provider = new CustomOpenAICompletionsProvider({
      id: "ovms",
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      models: {
        "qwen3.6": { contextWindow: 200_000, maxOutputTokens: 4096, presets: { fast: {} } },
      },
    });

    expect(provider.listModels()).toEqual([
      {
        provider: "ovms",
        model: "qwen3.6",
        presets: [{ value: "fast" }],
        contextWindow: 200_000,
        maxOutputTokens: 4096,
      },
    ]);
    expect(provider.capabilities("qwen3.6").preferredEditTool).toBe("replace");
    expect(() => provider.capabilities("unknown")).toThrow(/unknown model/);
  });

  it("applies a preset only to the model that defines it", () => {
    const provider = new CustomOpenAICompletionsProvider({
      id: "ovms",
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      models: {
        "qwen3.6": { presets: { fast: { temperature: 0.2 } } },
        "gpt-oss-20b": {},
      },
    });

    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      modelConfig: { provider: "ovms", model: "gpt-oss-20b", preset: "fast" },
    });

    expect(params.temperature).toBeUndefined();
  });

  it("maps preset sampling knobs onto the chat request, maxTokens -> max_tokens", () => {
    const provider = new CustomOpenAICompletionsProvider({
      id: "ovms",
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      models: {
        "qwen3.6": {
          presets: {
            fast: { temperature: 0.2, topP: 0.9, maxTokens: 2048, extraBody: { seed: 42 } },
          },
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widen the protected method
    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      modelConfig: { provider: "ovms", model: "qwen3.6", preset: "fast" },
    }) as Record<string, unknown>;

    expect(params).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 2048,
      seed: 42,
    });
    expect(params).not.toHaveProperty("max_output_tokens");
  });

  it("keeps an invocation output cap more specific than the chat preset", () => {
    const provider = new CustomOpenAICompletionsProvider({
      id: "ovms",
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      models: { m: { presets: { long: { maxTokens: 8192 } } } },
    });
    const params = (provider as unknown as OpenAIExposed).buildParams({
      ...REQUEST,
      maxOutputTokens: 1000,
      modelConfig: { provider: "ovms", model: "m", preset: "long" },
    });
    expect(params.max_tokens).toBe(1000);
  });

  it("rejects an unknown preset for the chosen model", () => {
    const provider = new CustomOpenAICompletionsProvider({
      id: "ovms",
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      models: { "qwen3.6": { presets: { fast: {} } } },
    });

    expect(() =>
      provider.validateConfig({ provider: "ovms", model: "qwen3.6", preset: "nope" }),
    ).toThrow(/unknown preset "nope"/);
  });
});

it.each(["openai-responses-compatible", "openai-completions-compatible", "anthropic-compatible"])(
  "preserves configured image support metadata for %s",
  async (type) => {
    const provider = await configuredProvider("local", type, {
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { vision: { supportsImages: true }, text: { supportsImages: false }, unknown: {} },
    });
    expect(
      provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
    ).toEqual([
      { model: "vision", supportsImages: true },
      { model: "text", supportsImages: false },
      { model: "unknown", supportsImages: undefined },
    ]);
  },
);

describe("custom model metadata", () => {
  it.each(["openai-responses-compatible", "openai-completions-compatible", "anthropic-compatible"])(
    "adds a manual model with JSON patch support over %s",
    async (type) => {
      const provider = await configuredProvider("manual", type, {
        endpoint: "http://localhost:8787/v1",
        apiKey: "test-key",
        models: {
          custom: {
            label: "Custom model",
            contextWindow: 100000,
            maxInputTokens: 90000,
            maxOutputTokens: 10000,
            reasoning: { supported: true },
            preferredEditTool: "patch",
          },
        },
      });
      expect(provider.listModels()).toMatchObject([
        {
          model: "custom",
          label: "Custom model",
          maxInputTokens: 90000,
          reasoning: { supported: true },
          preferredEditTool: "patch",
        },
      ]);
      expect(provider.capabilities("custom")).toMatchObject({
        preferredEditTool: "patch",
        customToolInput: { supported: false, grammars: [] },
      });
    },
  );

  it("advertises explicitly configured Responses custom input and grammars", async () => {
    const provider = await configuredProvider("manual", "openai-responses-compatible", {
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: {
        custom: {
          customToolInput: { supported: true, grammars: ["lark", "regex"] },
          preferredEditTool: "replace",
        },
      },
    });
    expect(provider.capabilities("custom")).toMatchObject({
      customToolInput: { supported: true, grammars: ["lark", "regex"] },
      preferredEditTool: "replace",
    });
  });
});

describe("custom provider failure classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The client captures its fetch at construction, so the fixture is installed first.
  async function run() {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { "my-model": {} },
    });
    for await (const event of provider.stream(REQUEST, new AbortController().signal, {
      conversationId: "conversation" as ConversationId,
    }))
      void event;
  }

  it("classifies a custom endpoint rate limit as transient through the shared classifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "slow down",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          },
          // A zero retry-after keeps the SDK's own retries from sleeping between attempts.
          { status: 429, headers: { "retry-after": "0" } },
        ),
      ),
    );
    await expect(run()).rejects.toMatchObject({
      name: "TransientModelFailure",
      reason: "rate_limit",
      retryAfterMs: 0,
    });
  });

  it("keeps a permanent endpoint error permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "bad request", type: "invalid_request_error" } },
          { status: 400 },
        ),
      ),
    );
    const error = await run().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).not.toBeInstanceOf(TransientModelFailure);
    expect(error).toMatchObject({ status: 400 });
  });
});
