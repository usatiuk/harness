import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemorySecretStore } from "@harness/secrets";
import {
  HarnessClient,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
} from "@harness/client";
import { buildServerHarness, runStdioServer, type ServerHarness } from "./index.ts";
import * as nodeTransport from "@harness/client/node";
import {
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appProvidersRequest,
  appSettingsRequest,
} from "./client-protocol.ts";
import * as credentials from "./credential-store.ts";
import { httpGateway, json } from "../../litellm/src/http-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("preserves a deterministic startup failure when a shutdown signal races it", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-startup-signal-defect-"));
  vi.stubEnv("HARNESS_HOME", home);
  const pair = createInProcessMessageConnectionPair();
  vi.spyOn(nodeTransport, "createNdjsonMessageConnection").mockReturnValue(pair.right);
  const defect = new TypeError("Fixture credential backend defect");
  vi.spyOn(credentials, "credentialStoreForRead").mockImplementation(async () => {
    process.emit("SIGINT");
    throw defect;
  });
  try {
    await expect(runStdioServer()).rejects.toBe(defect);
  } finally {
    pair.left.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

it("aborts startup discovery, drains its socket and releases the SQLite lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-provider-startup-cancel-"));
  let entered!: () => void;
  let disconnected!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const gateway = await httpGateway((_req, response) => {
    response.on("close", disconnected);
    entered();
  });
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_STARTUP_TEST_KEY", "fixture-key");
  for (const env of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(env, "");
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      providers: {
        work: {
          type: "litellm",
          config: { baseUrl: gateway.url, apiKey: { env: "HARNESS_STARTUP_TEST_KEY" } },
        },
      },
    }),
  );
  const pair = createInProcessMessageConnectionPair();
  const controller = new AbortController();
  const startup = buildServerHarness(pair.right, { signal: controller.signal });
  const rejected = expect(startup).rejects.toMatchObject({ name: "AbortError" });
  try {
    await began;
    controller.abort();
    await rejected;
    await drained;
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ model: { provider: "demo", model: "demo-1" } }),
    );
    const next = createInProcessMessageConnectionPair();
    const harness = await buildServerHarness(next.right);
    await harness.close();
    next.left.dispose();
  } finally {
    pair.left.dispose();
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("manages two named gateway keys over RPC, preserves global selection, and discovers on restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-named-provider-rpc-"));
  const gateway = await httpGateway((req, res) => {
    if (req.path.endsWith("/v1/models"))
      return json(res, { data: [{ id: req.key === "work-key" ? "coding" : "personal-code" }] });
    return json(res, {
      data: [
        {
          model_name: "coding",
          model_info: {
            max_input_tokens: 200000,
            max_output_tokens: 32000,
            supports_reasoning: true,
            supports_adaptive_thinking: false,
            reasoning_effort_levels: ["low", "high"],
            default_reasoning_effort: "low",
            harness: { version: 1, contextWindow: 220000, pricing: { input: 2, output: 8 } },
          },
        },
      ],
    });
  });
  vi.stubEnv("HARNESS_HOME", home);
  for (const env of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(env, "");
  const secrets = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({
    store: secrets,
    kind: "dpapi",
  });
  const loginBackend = vi
    .spyOn(credentials, "credentialStoreForLogin")
    .mockResolvedValue({ store: secrets, kind: "dpapi" });
  const settings = {
    model: { provider: "work", model: "coding" },
    providers: {
      work: { type: "litellm", label: "Work gateway", config: { baseUrl: gateway.url } },
      personal: { type: "litellm", label: "Personal gateway", config: { baseUrl: gateway.url } },
    },
  };
  await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  let harness: ServerHarness | undefined;
  let client: HarnessClient | undefined;
  let domain: HarnessDomainClient;
  async function start() {
    const pair = createInProcessMessageConnectionPair();
    harness = await buildServerHarness(pair.right);
    client = new HarnessClient({
      connection: pair.left,
      client: { name: "named-auth-test", version: "1" },
    });
    domain = new HarnessDomainClient(client);
    await domain.start();
    return client;
  }
  try {
    let rpc = await start();
    expect((await rpc.peer.request(appSettingsRequest, {})).settings.model).toEqual({
      ...settings.model,
      preset: null,
    });
    expect(
      (await rpc.peer.request(appProvidersRequest, {})).find((provider) => provider.id === "work"),
    ).toMatchObject({ label: "Work gateway", catalog: "missing-credentials", registered: false });
    expect(
      await rpc.peer.request(appAuthLoginRequest, { provider: "work", key: "work-key" }),
    ).toEqual({ restartRequired: true });
    await rpc.peer.request(appAuthLoginRequest, { provider: "personal", key: "personal-key" });
    expect(await secrets.get("provider-instance:work:api-key")).toBe("work-key");
    expect(await secrets.get("provider-instance:personal:api-key")).toBe("personal-key");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({
      model: settings.model,
    });
    expect(gateway.requests).toHaveLength(0);
    await harness!.close();
    rpc.closeConnection();
    rpc = await start();
    const models = await rpc.models();
    expect(domain!.availableModels().find((model) => model.provider === "work")).toMatchObject({
      contextWindow: 220000,
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      reasoning: {
        supported: true,
        adaptiveThinking: false,
        effortLevels: ["high", "low"],
        defaultEffort: "low",
      },
      pricing: { input: 2, output: 8 },
    });
    expect(models.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "work", model: "coding" }),
        expect.objectContaining({ provider: "personal", model: "personal-code" }),
      ]),
    );
    const statuses = await rpc.peer.request(appProvidersRequest, {});
    expect(
      statuses
        .filter((provider) => provider.type === "litellm")
        .every((provider) => provider.catalog === "ready" && provider.modelCount === 1),
    ).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("work-key");
    await rpc.peer.request(appAuthLogoutRequest, { provider: "work" });
    expect(await secrets.get("provider-instance:work:api-key")).toBeNull();
    expect(await secrets.get("provider-instance:personal:api-key")).toBe("personal-key");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({
      model: settings.model,
    });
    await harness!.close();
    rpc.closeConnection();
    rpc = await start();
    expect((await rpc.models()).models.some((model) => model.provider === "work")).toBe(false);
    expect((await rpc.peer.request(appSettingsRequest, {})).settings.model?.provider).toBe("work");
    const invalid = {
      ...settings,
      providers: {
        ...settings.providers,
        work: { ...settings.providers.work, config: { baseUrl: "not a URL" } },
      },
    };
    await writeFile(join(home, "settings.json"), JSON.stringify(invalid));
    loginBackend.mockClear();
    await expect(
      rpc.peer.request(appAuthLoginRequest, { provider: "work", key: "new-key" }),
    ).rejects.toThrow(
      `in ${join(home, "settings.json")}: providers.work.config.baseUrl: Invalid URL`,
    );
    expect(loginBackend).not.toHaveBeenCalled();
  } finally {
    await harness?.close();
    client?.closeConnection();
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});
