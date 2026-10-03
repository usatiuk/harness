import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MemorySecretStore } from "@harness/secrets";
import { defineProviderType } from "@harness/protocol";
import { parseSettingsDoc, parseProjectDoc } from "@harness/config";
import { authRegistry, providerEntries, providerPlugins } from "./auth.ts";

afterEach(() => vi.unstubAllEnvs());

describe("named provider instances", () => {
  it("keeps arbitrary legacy IDs and opaque plugin secret slots in distinct namespaces", async () => {
    const store = new MemorySecretStore();
    const type = defineProviderType({
      type: "slot-fixture",
      configSchema: z.strictObject({}),
      create(context) {
        return {
          async buildProvider() {
            await context.secrets.set("b:api-key", "producer-secret");
            return null;
          },
        };
      },
    });
    const entries = providerEntries(
      store,
      {
        providers: { a: { type: "slot-fixture", config: {} } },
        customProviders: {
          "a:b": {
            type: "openai-completions-compatible",
            endpoint: "http://local/v1",
            models: { coding: {} },
            apiKey: { stored: true },
          },
        },
      },
      [...providerPlugins, { id: "slot-fixture", providerTypes: () => [type] }],
    );
    await entries.get("a")!.instance.buildProvider();
    expect(await entries.get("a:b")!.instance.buildProvider()).toBeNull();
    expect(await store.get("provider-instance:a:b%3Aapi-key")).toBe("producer-secret");
    expect(await store.get("provider-instance:a%3Ab:api-key")).toBeNull();
  });
  it("normalizes legacy compatible providers and secure named connections through one registry", async () => {
    const store = new MemorySecretStore();
    const config = {
      endpoint: "http://localhost:8000/v1",
      models: { coding: { contextWindow: 4096, presets: { fast: { temperature: 0.2 } } } },
    };
    const entries = providerEntries(
      store,
      parseSettingsDoc(
        {
          customProviders: {
            legacy: { type: "openai-completions-compatible", ...config, apiKey: "dummy" },
          },
          providers: {
            secure: { type: "openai-completions-compatible", label: "Secure local", config },
          },
        },
        "fixture",
      ),
    );
    expect(entries.get("legacy")?.instance.auth).toBeUndefined();
    expect((await entries.get("legacy")!.instance.buildProvider())?.listModels()[0]).toMatchObject({
      provider: "legacy",
      model: "coding",
      contextWindow: 4096,
      presets: [{ value: "fast" }],
    });
    const secure = entries.get("secure")!.instance;
    expect(await secure.buildProvider()).toBeNull();
    if (secure.auth?.kind !== "api-key") throw new Error("Expected scoped key auth");
    await secure.auth.submit("named-key");
    expect(await store.get("provider-instance:secure:api-key")).toBe("named-key");
    expect((await secure.buildProvider())?.listModels()[0]?.provider).toBe("secure");
    expect(() =>
      providerEntries(store, {
        customProviders: {
          openai: { type: "openai-completions-compatible", ...config, apiKey: "dummy" },
        },
      }),
    ).toThrow("Duplicate");
    expect(() =>
      providerEntries(store, {
        customProviders: {
          bad: {
            type: "openai-completions-compatible",
            endpoint: "http://local",
            apiKey: "dummy",
            models: { coding: { fileTools: "apply_patch" } },
          },
        },
      }),
    ).toThrow("Invalid config");
  });
  it("isolates stored keys, labels and identities while retaining legacy slots", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = new MemorySecretStore();
    const settings = {
      providers: {
        work: { type: "openai-api", label: "Work account", config: {} },
        personal: { type: "openai-api", config: {} },
        claude: { type: "anthropic-api", config: {} },
        go: { type: "opencode-go", config: {} },
      },
    };
    const registry = authRegistry(store, settings);
    for (const [id, key] of [
      ["work", "sk-work"],
      ["personal", "sk-personal"],
      ["claude", "sk-ant-work"],
      ["go", "go-key"],
      ["openai", "sk-default"],
    ]) {
      const entry = registry.get(id!)!;
      if (entry.method.kind !== "api-key") throw new Error("Expected key auth");
      await entry.method.submit(key!);
      expect(
        (await providerEntries(store, settings).get(id!)!.instance.buildProvider())?.provider,
      ).toBe(id);
    }
    expect(await store.get("provider-instance:work:api-key")).toBe("sk-work");
    expect(await store.get("apikey:openai")).toBe("sk-default");
    expect(registry.get("work")?.defaultModel).toBeUndefined();
    expect(registry.get("work")?.method.label).toBe("Work account");
    await registry.get("work")!.method.logout();
    expect(await providerEntries(store, settings).get("work")!.instance.buildProvider()).toBeNull();
    expect(
      (await providerEntries(store, settings).get("personal")!.instance.buildProvider())?.provider,
    ).toBe("personal");
    const renamed = authRegistry(store, {
      providers: { personal: { ...settings.providers.personal, label: "New label" } },
    });
    expect((await renamed.get("personal")!.method.status()).authenticated).toBe(true);
  });

  it("treats an explicit environment reference as the only credential source", async () => {
    vi.stubEnv("HARNESS_NAMED_TEST_KEY", "");
    const store = new MemorySecretStore();
    await store.set("provider-instance:work:api-key", "sk-stored");
    const entry = authRegistry(store, {
      providers: {
        work: {
          type: "openai-api",
          config: { apiKey: { env: "HARNESS_NAMED_TEST_KEY" } },
        },
      },
    }).get("work")!;
    expect(
      await providerEntries(store, {
        providers: {
          work: { type: "openai-api", config: { apiKey: { env: "HARNESS_NAMED_TEST_KEY" } } },
        },
      })
        .get("work")!
        .instance.buildProvider(),
    ).toBeNull();
    if (entry.method.kind !== "api-key") throw new Error("Expected key auth");
    expect(entry.method.canStore).toBe(false);
    await expect(entry.method.submit("sk-key")).rejects.toThrow("managed by the environment");
    vi.stubEnv("HARNESS_NAMED_TEST_KEY", "sk-env");
    expect((await entry.method.status()).source).toBe("env");
  });

  it("supports a contributed type and validates every config before constructing any instance", () => {
    let created = 0;
    const type = defineProviderType({
      type: "test",
      configSchema: z.strictObject({ number: z.number() }),
      create() {
        created++;
        return { buildProvider: async () => null };
      },
    });
    const plugins = [...providerPlugins, { id: "test-plugin", providerTypes: () => [type] }];
    const store = new MemorySecretStore();
    expect(() =>
      providerEntries(
        store,
        {
          providers: {
            first: { type: "test", config: { number: 1 } },
            second: { type: "test", config: { number: "wrong" } },
          },
        },
        plugins,
      ),
    ).toThrow("Invalid config for provider instance 'second'");
    expect(created).toBe(0);
    expect(
      providerEntries(
        store,
        { providers: { first: { type: "test", config: { number: 1 } } } },
        plugins,
      ).has("first"),
    ).toBe(true);
    expect(created).toBe(1);
  });

  it("rejects unknown types, duplicate IDs and machine settings in project layers", () => {
    const store = new MemorySecretStore();
    expect(() =>
      providerEntries(store, { providers: { demo: { type: "openai-api", config: {} } } }),
    ).toThrow("Duplicate");
    expect(() =>
      providerEntries(store, { providers: { openai: { type: "anthropic-api", config: {} } } }),
    ).toThrow("retain type");
    expect(() =>
      providerEntries(store, { providers: { work: { type: "unknown", config: {} } } }),
    ).toThrow("Unknown provider type");
    expect(() => parseProjectDoc({ providers: {} }, "project")).toThrow("providers");
    expect(() => parseSettingsDoc({ profiles: { bad: { providers: {} } } }, "global")).toThrow(
      "providers",
    );
  });
});
