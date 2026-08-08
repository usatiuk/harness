import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@harness/protocol";
import { CustomOpenAIProvider } from "./custom-openai.ts";
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
  it("declares one sized model with a preset axis", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      model: "my-model",
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      presets: { fast: { temperature: 0.2 } },
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

  it("leaves limits and presets off the catalog when unset", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      model: "my-model",
    });

    expect(provider.listModels()).toEqual([{ provider: "local", model: "my-model", presets: [] }]);
  });

  it("selects the fileTools dialect, defaulting to function-only string_replace", () => {
    const defaulted = new CustomOpenAIProvider({
      id: "a",
      endpoint: "http://a",
      apiKey: "k",
      model: "m",
    });
    const patched = new CustomOpenAIProvider({
      id: "b",
      endpoint: "http://b",
      apiKey: "k",
      model: "m",
      fileTools: "apply_patch",
    });

    expect(defaulted.capabilities()).toEqual({
      contentTypes: ["text"],
      toolCalling: true,
      fileTools: "string_replace",
    });
    expect(patched.capabilities().fileTools).toBe("apply_patch");
  });
});

describe("CustomOpenAIProvider.validateConfig", () => {
  it("rejects a preset the provider does not define", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      model: "my-model",
      presets: { fast: {} },
    });

    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "nope" }),
    ).toThrow(/unknown preset "nope"/);
  });

  it("accepts an absent preset or one the provider defines", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      model: "my-model",
      presets: { fast: {} },
    });

    expect(() => provider.validateConfig({ provider: "local", model: "my-model" })).not.toThrow();
    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "fast" }),
    ).not.toThrow();
  });
});

describe("CustomOpenAIProvider request shaping", () => {
  it("drops the reasoning field and applies the selected preset", () => {
    const provider = new CustomOpenAIProvider({
      id: "local",
      endpoint: "http://localhost:8787/v1",
      apiKey: "test-key",
      model: "my-model",
      presets: { fast: { temperature: 0.2, topP: 0.9, maxTokens: 2048, extraBody: { seed: 42 } } },
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
      model: "my-model",
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
      model: "my-model",
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
      model: "my-model",
    });

    const params = (provider as unknown as OpenAIExposed).buildParams(REQUEST);

    expect(params).not.toHaveProperty("reasoning");
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
  });
});

describe("CustomAnthropicProvider", () => {
  it("lists a sized model with the configured preset axis", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      model: "my-model",
      contextWindow: 64_000,
      maxOutputTokens: 4096,
      presets: { long: { maxTokens: 8192 } },
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

  it("drops thinking/effort and applies the selected preset, tunneling extras through extra_body", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      model: "my-model",
      presets: {
        creative: { temperature: 1.1, maxTokens: 4096, topK: 40, extraBody: { seed: 7 } },
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

  it("defaults the request cap from the configured maxOutputTokens, not the built-in fallback", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      model: "my-model",
      maxOutputTokens: 65_536,
    });

    const config = (provider as unknown as AnthropicExposed).buildConfig(REQUEST);

    expect(config.maxTokens).toBe(65_536);
  });

  it("lets a preset maxTokens override the configured cap", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      model: "my-model",
      maxOutputTokens: 65_536,
      presets: { short: { maxTokens: 8192 } },
    });

    const config = (provider as unknown as AnthropicExposed).buildConfig({
      ...REQUEST,
      modelConfig: { provider: "local", model: "my-model", preset: "short" },
    });

    expect(config.maxTokens).toBe(8192);
  });

  it("selects the fileTools dialect, defaulting to the Messages-native text_editor", () => {
    const defaulted = new CustomAnthropicProvider({
      id: "a",
      endpoint: "http://a",
      apiKey: "k",
      model: "m",
    });
    const patched = new CustomAnthropicProvider({
      id: "b",
      endpoint: "http://b",
      apiKey: "k",
      model: "m",
      fileTools: "string_replace",
    });

    expect(defaulted.capabilities().fileTools).toBe("text_editor");
    expect(patched.capabilities().fileTools).toBe("string_replace");
  });

  it("rejects an unknown preset", () => {
    const provider = new CustomAnthropicProvider({
      id: "local",
      endpoint: "http://localhost:8787",
      apiKey: "test-key",
      model: "my-model",
      presets: { long: {} },
    });

    expect(() =>
      provider.validateConfig({ provider: "local", model: "my-model", preset: "unset" }),
    ).toThrow(/unknown preset "unset"/);
  });
});

describe("factory wiring", () => {
  it("creates an openai-compatible plugin keyed by its config id", () => {
    const plugin = createCustomProviderPlugin("ollama", {
      type: "openai-compatible",
      endpoint: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "llama3.2",
      presets: { default: { temperature: 0.7 } },
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
      model: "neural-chat",
    });

    expect(plugin.id).toBe("lmstudio");
    const models = plugin.providers?.().flatMap((p) => p.listModels()) ?? [];
    expect(models).toEqual([{ provider: "lmstudio", model: "neural-chat", presets: [] }]);
  });

  it("builds the full plugin set from a parsed settings section", () => {
    const plugins = createCustomProviderPlugins({
      a: { type: "openai-compatible", endpoint: "http://a", apiKey: "k", model: "m1" },
      b: { type: "anthropic-compatible", endpoint: "http://b", apiKey: "k", model: "m2" },
    });

    expect(plugins.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
