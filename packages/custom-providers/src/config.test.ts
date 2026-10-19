import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalSettings } from "@harness/config";
import { configuredProviders } from "./provider-fixture.ts";
const homes: string[] = [];
async function tmp() {
  const home = await mkdtemp(join(tmpdir(), "harness-custom-config-"));
  homes.push(home);
  return home;
}
async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify({ version: 1, ...(value as Record<string, unknown>) }));
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const model = { provider: "demo", model: "demo-1" };
async function validateCustomSettings(home: string) {
  return configuredProviders(await readGlobalSettings(home));
}
describe("plugin-owned compatible provider configuration", () => {
  it("rejects a custom provider type outside the discriminated union", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        mine: {
          type: "openai-compatible",
          config: { endpoint: "http://a", apiKey: "k", model: "m" },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(/type/);
  });

  it("parses a valid openai-completions-compatible provider", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        ovms: {
          type: "openai-completions-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: {
              "qwen3.6": {
                contextWindow: 200_000,
                maxOutputTokens: 4096,
                presets: { fast: { temperature: 0.2 } },
              },
            },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).resolves.toBeTruthy();
  });

  it.each(["openai-responses-compatible", "openai-completions-compatible", "anthropic-compatible"])(
    "rejects unsupported endpoint schemes before constructing %s",
    async (type) => {
      const home = await tmp();
      await writeJson(join(home, "settings.json"), {
        model,
        providers: {
          local: {
            type,
            config: { endpoint: "ftp://invalid/v1", apiKey: "k", models: { m: {} } },
          },
        },
      });
      await expect(validateCustomSettings(home)).rejects.toThrow(/endpoint|URL/);
    },
  );

  it("rejects unknown custom model fields instead of silently stripping typos", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        local: {
          type: "openai-responses-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: { m: { maxOutputToken: 4096 } },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(/maxOutputToken/);
  });

  it.each([
    [{ contextWindow: 1024, maxOutputTokens: 2048 }, /maxOutputTokens cannot exceed contextWindow/],
    [
      { maxOutputTokens: 1024, presets: { unsafe: { maxTokens: 2048 } } },
      /preset maxTokens cannot exceed the model's output capacity/,
    ],
    [
      { contextWindow: 1024, presets: { unsafe: { maxTokens: 2048 } } },
      /preset maxTokens cannot exceed the model's output capacity/,
    ],
  ])("rejects incoherent custom-model capacity %#", async (entry, expected) => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        local: {
          type: "openai-responses-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: { m: entry },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(expected);
  });

  it.each([
    "model",
    "tools",
    "stream",
    "store",
    "max_tokens",
    "previous_response_id",
    "prompt_cache_key",
    "truncation",
    "background",
  ])("rejects OpenAI extraBody overriding Harness-owned field %s", async (field) => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        local: {
          type: "openai-responses-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: { m: { presets: { unsafe: { extraBody: { [field]: "override" } } } } },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(
      new RegExp(`cannot override Harness-owned field '${field}'`),
    );
  });

  it("rejects custom input on a completions-typed model", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        ovms: {
          type: "openai-completions-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: { "qwen3.6": { customToolInput: { supported: true, grammars: [] } } },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(
      /does not support custom tool input/,
    );
  });

  it("rejects custom input on an anthropic-typed model", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        local: {
          type: "anthropic-compatible",
          config: {
            endpoint: "http://localhost:1234",
            apiKey: "k",
            models: { claude: { customToolInput: { supported: true, grammars: [] } } },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(
      /does not support custom tool input/,
    );
  });

  it("rejects a custom provider with no models (empty catalog)", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        dead: {
          type: "openai-responses-compatible",
          config: {
            endpoint: "http://a",
            apiKey: "k",
            models: {},
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(/at least one model/);
  });

  it("rejects the pre-refactor provider-level model shape", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        old: {
          type: "openai-responses-compatible",
          config: {
            endpoint: "http://a",
            apiKey: "k",
            model: "m",
            presets: { fast: { temperature: 0.2 } },
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(/models/);
  });

  it("rejects sendInstructionsAsSystem on the completions type (not a field there)", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      providers: {
        ovms: {
          type: "openai-completions-compatible",
          config: {
            endpoint: "http://localhost:8000/v1",
            apiKey: "k",
            models: { "qwen3.6": {} },
            sendInstructionsAsSystem: true,
          },
        },
      },
    });
    await expect(validateCustomSettings(home)).rejects.toThrow(/sendInstructionsAsSystem/);
  });
});
