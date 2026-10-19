import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Shell startup is an OS edge; the real cold-owner path is covered in shell-startup.test.ts.
vi.mock("@harness/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@harness/execution")>()),
  initializeUserShellEnvironment: vi.fn(async () => {}),
}));
import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { MemorySecretStore } from "@harness/secrets";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { readGlobalSettings, updateGlobalModel } from "@harness/config";
import { providerEntries, providerPlugins } from "./auth.ts";
import { codexProviderType } from "@harness/openai-codex";
import { buildServerHarness } from "./index.ts";
import { appProvidersRequest, appProviderConfigUpdateRequest } from "./client-protocol.ts";
import * as credentials from "./credential-store.ts";

beforeEach(() => {
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
  ])
    vi.stubEnv(name, "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("defaults supported connections to native search and preserves explicit opt-outs", async () => {
  const store = new MemorySecretStore();
  for (const type of [
    "openai-api",
    "openai-codex",
    "anthropic-api",
    "gemini-api",
    "mistral-api",
    "mistral-vibe",
  ]) {
    for (const webSearch of [undefined, false, true]) {
      const entry = providerEntries(store, {
        providers: { named: { type, config: webSearch === undefined ? {} : { webSearch } } },
      }).get("named")!;
      expect(entry.settings.find((setting) => setting.key === "webSearch")?.value).toBe(
        webSearch ?? true,
      );
      if (entry.instance.auth?.kind === "api-key") {
        await entry.instance.auth.submit(type === "anthropic-api" ? "sk-ant-test" : "sk-test");
        expect((await entry.instance.buildProvider())?.providerOptions).toEqual({
          webSearch: webSearch ?? true,
        });
      }
      if (type === "openai-codex")
        expect(
          codexProviderType.configSchema.parse(webSearch === undefined ? {} : { webSearch }),
        ).toMatchObject({ webSearch: webSearch ?? true });
    }
  }
  expect(providerEntries(store).get("opencode-go")!.settings).toEqual([]);
});

it("saves search over RPC without replacing connection details or sibling settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-provider-search-"));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_SEARCH_KEY", "");
  const store = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store, kind: "dpapi" });
  const settingsPath = join(home, "settings.json");
  const named = {
    type: "openai-api",
    label: "Work search",
    config: { apiKey: { env: "HARNESS_SEARCH_KEY" }, baseUrl: "https://example.com/v1" },
  };
  const mistral = {
    type: "mistral-vibe",
    config: { models: { custom: { label: "Custom", contextWindow: 4096 } } },
  };
  await writeFile(
    settingsPath,
    JSON.stringify({ version: 1, providers: { work: named, team: mistral } }),
  );
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "search-test", version: "1" },
  });
  try {
    await client.start();
    const statuses = await client.peer.request(appProvidersRequest, {});
    expect(statuses.find(({ id }) => id === "work")).toMatchObject({
      settings: [{ key: "webSearch", value: true }],
      authenticated: false,
    });
    expect(statuses.find(({ id }) => id === "opencode-go")?.settings).toEqual([]);
    await Promise.all([
      client.peer.request(appProviderConfigUpdateRequest, {
        provider: "work",
        patch: { webSearch: false },
      }),
      client.peer.request(appProviderConfigUpdateRequest, {
        provider: "openai",
        patch: { webSearch: false },
      }),
      client.peer.request(appProviderConfigUpdateRequest, {
        provider: "team",
        patch: { webSearch: false },
      }),
      updateGlobalModel(home, { provider: "demo", model: "demo-1" }),
    ]);
    const doc = await readGlobalSettings(home);
    expect(doc).toMatchObject({
      model: { provider: "demo", model: "demo-1" },
      providers: {
        work: { ...named, config: { ...named.config, webSearch: false } },
        team: { ...mistral, config: { ...mistral.config, webSearch: false } },
        openai: {
          type: "openai-api",
          config: { apiKey: { env: "OPENAI_API_KEY", stored: true }, webSearch: false },
        },
      },
    });
    expect(
      (await client.peer.request(appProvidersRequest, {}))
        .find(({ id }) => id === "work")
        ?.settings.find((setting) => setting.key === "webSearch")?.value,
    ).toBe(false);
    // A fresh provider construction applies the persisted choices.
    const reopened = providerEntries(store, doc);
    vi.stubEnv("HARNESS_SEARCH_KEY", "sk-test");
    expect((await reopened.get("work")!.instance.buildProvider())?.providerOptions).toEqual({
      webSearch: false,
    });
    const team = reopened.get("team")!.instance;
    if (team.auth?.kind !== "api-key") throw new Error("Expected Mistral API key auth");
    await team.auth.submit("test-key");
    expect((await team.buildProvider())?.providerOptions).toEqual({ webSearch: false });
    const before = await readFile(settingsPath, "utf8");
    for (const provider of ["missing", "opencode-go"])
      await expect(
        client.peer.request(appProviderConfigUpdateRequest, {
          provider,
          patch: { webSearch: true },
        }),
      ).rejects.toThrow();
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    await expect(
      client.peer.request(appProviderConfigUpdateRequest, {
        provider: "work",
        patch: { webSearch: true },
      }),
    ).resolves.toEqual({ restartRequired: true });
    expect(
      (await client.peer.request(appProvidersRequest, {}))
        .find(({ id }) => id === "work")
        ?.settings.find((setting) => setting.key === "webSearch")?.value,
    ).toBe(true);
    expect(JSON.stringify(await client.peer.request(appProvidersRequest, {}))).not.toContain(
      "sk-test",
    );
    expect(JSON.stringify(await client.peer.request(appProvidersRequest, {}))).not.toContain(
      "test-key",
    );
  } finally {
    client.closeConnection();
    await harness.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("uses the same RPC for schema-exposed provider settings and rejects hidden or invalid changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-provider-settings-"));
  vi.stubEnv("HARNESS_HOME", home);
  const store = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store, kind: "dpapi" });
  const fixture = defineProviderType({
    type: "settings-fixture",
    configSchema: z
      .strictObject({
        compactOutput: z
          .boolean()
          .default(true)
          .meta({ harnessSetting: true, title: "Compact output" }),
        verboseOutput: z
          .boolean()
          .default(false)
          .meta({ harnessSetting: true, title: "Verbose output" }),
        apiKey: z.string(),
        hiddenFlag: z.boolean().default(false),
      })
      .refine(
        (config) => config.compactOutput || !config.verboseOutput,
        "Verbose output requires compact output",
      ),
    create: () => ({ buildProvider: async () => null }),
  });
  const plugin = { id: "settings-fixture", providerTypes: () => [fixture] };
  providerPlugins.push(plugin);
  const path = join(home, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      providers: { fixture: { type: fixture.type, config: { apiKey: "private-fixture-key" } } },
    }),
  );
  const pair = createInProcessMessageConnectionPair();
  let harness: Awaited<ReturnType<typeof buildServerHarness>> | undefined;
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "generic-settings-test", version: "1" },
  });
  try {
    harness = await buildServerHarness(pair.right);
    await client.start();
    const status = (await client.peer.request(appProvidersRequest, {})).find(
      ({ id }) => id === "fixture",
    )!;
    expect(status.settings).toEqual([
      { key: "compactOutput", title: "Compact output", description: null, value: true },
      { key: "verboseOutput", title: "Verbose output", description: null, value: false },
    ]);
    expect(JSON.stringify(status)).not.toContain("private-fixture-key");
    await client.peer.request(appProviderConfigUpdateRequest, {
      provider: "fixture",
      patch: { compactOutput: false },
    });
    expect((await readGlobalSettings(home)).providers?.fixture?.config).toEqual({
      apiKey: "private-fixture-key",
      compactOutput: false,
    });
    const before = await readFile(path, "utf8");
    for (const patch of [
      { apiKey: false },
      { hiddenFlag: true },
      { unknown: true },
      { verboseOutput: true },
    ])
      await expect(
        client.peer.request(appProviderConfigUpdateRequest, { provider: "fixture", patch }),
      ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      (await client.peer.request(appProvidersRequest, {})).find(({ id }) => id === "fixture")!
        .settings[0]!.value,
    ).toBe(false);
  } finally {
    client.closeConnection();
    await harness?.close();
    providerPlugins.splice(providerPlugins.indexOf(plugin), 1);
    await rm(home, { recursive: true, force: true });
  }
});
