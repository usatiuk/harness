import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/protocol";
import { CustomOpenAIProvider } from "./custom-openai.ts";
import { CustomOpenAICompletionsProvider } from "./custom-openai-completions.ts";
import { CustomAnthropicProvider } from "./custom-anthropic.ts";
import { createCustomProviderPlugin, createCustomProviderPlugins } from "./factory.ts";

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

  it("selects the per-model fileTools dialect, defaulting to function-only string_replace", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      models: { patched: { fileTools: "apply_patch" }, plain: {} },
    });

    expect(provider.capabilities("patched").fileTools).toBe("apply_patch");
    expect(provider.capabilities("plain").fileTools).toBe("string_replace");
    expect(provider.capabilities("unknown").fileTools).toBe("string_replace");
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

  it("selects the per-model fileTools dialect, defaulting to the Messages-native text_editor", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      models: {
        patched: { fileTools: "string_replace" },
        plain: {},
      },
    });

    expect(provider.capabilities("patched").fileTools).toBe("string_replace");
    expect(provider.capabilities("plain").fileTools).toBe("text_editor");
    expect(provider.capabilities("unknown").fileTools).toBe("text_editor");
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

describe("factory wiring", () => {
  it("creates an openai-responses-compatible plugin keyed by its config id", () => {
    const plugin = createCustomProviderPlugin("ollama", {
      type: "openai-responses-compatible",
      endpoint: "http://localhost:11434/v1",
      apiKey: "ollama",
      models: { "llama3.2": { presets: { default: { temperature: 0.7 } } } },
    });

    expect(plugin.id).toBe("ollama");
    const models = plugin.providers?.().flatMap((p) => p.listModels()) ?? [];
    expect(models).toEqual([
      { provider: "ollama", model: "llama3.2", presets: [{ value: "default" }] },
    ]);
  });

  it("creates an anthropic-compatible plugin", () => {
    const plugin = createCustomProviderPlugin("lmstudio", {
      type: "anthropic-compatible",
      endpoint: "http://localhost:1234",
      apiKey: "lm-studio",
      models: { "neural-chat": {} },
    });

    expect(plugin.id).toBe("lmstudio");
    const models = plugin.providers?.().flatMap((p) => p.listModels()) ?? [];
    expect(models).toEqual([{ provider: "lmstudio", model: "neural-chat", presets: [] }]);
  });

  it("creates an openai-completions-compatible plugin whose endpoint serves several models", () => {
    const plugin = createCustomProviderPlugin("ovms", {
      type: "openai-completions-compatible",
      endpoint: "http://localhost:8000/v1",
      apiKey: "ovms",
      models: { "qwen3.6": {}, "gpt-oss-20b": { presets: { high: {} } } },
    });

    expect(plugin.id).toBe("ovms");
    const models = plugin.providers?.().flatMap((p) => p.listModels()) ?? [];
    expect(models).toEqual([
      { provider: "ovms", model: "qwen3.6", presets: [] },
      { provider: "ovms", model: "gpt-oss-20b", presets: [{ value: "high" }] },
    ]);
  });

  it("builds the full plugin set from a parsed settings section", () => {
    const plugins = createCustomProviderPlugins({
      a: {
        type: "openai-responses-compatible",
        endpoint: "http://a",
        apiKey: "k",
        models: { m1: {} },
      },
      b: { type: "anthropic-compatible", endpoint: "http://b", apiKey: "k", models: { m2: {} } },
      c: {
        type: "openai-completions-compatible",
        endpoint: "http://c",
        apiKey: "k",
        models: { m3: {} },
      },
    });

    expect(plugins.map((p) => p.id)).toEqual(["a", "b", "c"]);
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
    expect(provider.capabilities("qwen3.6").fileTools).toBe("string_replace");
    expect(provider.capabilities("unknown").fileTools).toBe("string_replace");
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
