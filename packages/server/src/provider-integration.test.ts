import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemorySecretStore } from "@harness/secrets";
import { CodexAuth } from "@harness/openai-codex";
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
  appAuthUrlNotification,
  appProvidersRequest,
  appSettingsRequest,
} from "./client-protocol.ts";
import * as credentials from "./credential-store.ts";
import { httpGateway, json } from "../../litellm/src/http-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("displays device authorization over RPC, cancels it, then stores only the selected provider's session", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-device-rpc-"));
  vi.stubEnv("HARNESS_HOME", home);
  const store = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store, kind: "dpapi" });
  vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({ store, kind: "dpapi" });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      version: 1,
      providers: {
        work: { type: "openai-codex", config: {} },
        personal: { type: "openai-codex", config: {} },
      },
    }),
  );
  let authorize = false;
  let disabled = true;
  let stopped!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const jwt = (value: unknown) =>
    `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = input as string;
    if (url.endsWith("/deviceauth/usercode") && disabled)
      return new Response('private token response: {"access_token":"secret"}', { status: 404 });
    if (url.endsWith("/deviceauth/usercode"))
      return Response.json({ device_auth_id: "request", user_code: "RPC-CODE", interval: "1" });
    if (url.endsWith("/deviceauth/token")) {
      if (authorize)
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => {
            stopped();
            reject(init!.signal!.reason as Error);
          },
          { once: true },
        );
      });
    }
    expect(url).toBe("https://auth.openai.com/oauth/token");
    return Response.json({
      access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "rpc-account" } }),
      id_token: jwt({ email: "rpc@example.com" }),
      refresh_token: "rpc-refresh",
      expires_in: 3600,
    });
  }) satisfies typeof fetch);
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "device-rpc", version: "1" },
  });
  const controller = new AbortController();
  const prompts: unknown[] = [];
  let shown!: () => void;
  const displayed = new Promise<void>((resolve) => {
    shown = resolve;
  });
  client.peer.onNotification(appAuthUrlNotification, (prompt) => {
    prompts.push(prompt);
    shown();
  });
  try {
    await client.start();
    await expect(
      client.peer.request(appAuthLoginRequest, { provider: "work", key: null, flow: "device" }),
    ).rejects.toThrow("Enable device-code authentication");
    disabled = false;
    const login = client.peer.request(
      appAuthLoginRequest,
      { provider: "work", key: null, flow: "device" },
      { signal: controller.signal },
    );
    const failed = expect(login).rejects.toThrow();
    await displayed;
    controller.abort();
    await failed;
    await cancelled;
    expect(prompts).toEqual([
      { url: "https://auth.openai.com/codex/device", userCode: "RPC-CODE" },
    ]);
    expect(await store.get("provider-instance:work:oauth")).toBeNull();
    // A provider-list request reconciles the server after the cancelled operation drains.
    await client.peer.request(appProvidersRequest, {});
    authorize = true;
    await expect(
      client.peer.request(appAuthLoginRequest, { provider: "work", key: null, flow: "device" }),
    ).resolves.toEqual({ restartRequired: true });
    expect(await store.get("provider-instance:work:oauth")).toContain("rpc-refresh");
    expect(await store.get("provider-instance:personal:oauth")).toBeNull();
    expect(
      (await client.peer.request(appProvidersRequest, {})).find(
        (provider) => provider.id === "work",
      ),
    ).toMatchObject({ authenticated: true });
  } finally {
    await harness.close();
    client.closeConnection();
    await rm(home, { recursive: true, force: true });
  }
});

it("uses the newly configured OAuth type when a named API-key connection changes before restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-provider-type-edit-"));
  vi.stubEnv("HARNESS_HOME", home);
  for (const env of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(env, "");
  const store = new MemorySecretStore();
  await store.set("provider-instance:work:api-key", "old-key");
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({ store, kind: "dpapi" });
  vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({ store, kind: "dpapi" });
  const login = vi.spyOn(CodexAuth.prototype, "loginWithBrowser").mockResolvedValue({
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    idToken: "fixture-id-token",
    accountId: "fixture-account",
    expiresAt: Date.now() + 3600000,
  });
  const settingsPath = join(home, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ version: 1, providers: { work: { type: "openai-api", config: {} } } }),
  );
  const pair = createInProcessMessageConnectionPair();
  const harness = await buildServerHarness(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "type-edit-test", version: "1" },
  });
  try {
    await client.start();
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 1, providers: { work: { type: "openai-codex", config: {} } } }),
    );
    expect(
      (await client.peer.request(appProvidersRequest, {})).find(({ id }) => id === "work"),
    ).toMatchObject({ type: "openai-codex", kind: "oauth", registered: false, modelCount: 0 });
    await expect(
      client.peer.request(appAuthLoginRequest, { provider: "work", key: null, flow: "browser" }),
    ).resolves.toEqual({ restartRequired: true });
    expect(login).toHaveBeenCalledOnce();
    expect(await store.get("provider-instance:work:api-key")).toBe("old-key");
  } finally {
    await harness.close();
    client.closeConnection();
    await rm(home, { recursive: true, force: true });
  }
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
      version: 1,
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
      JSON.stringify({ version: 1, model: { provider: "demo", model: "demo-1" } }),
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
    version: 1,
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
      await rpc.peer.request(appAuthLoginRequest, {
        provider: "work",
        key: "work-key",
        flow: "browser",
      }),
    ).toEqual({ restartRequired: true });
    await rpc.peer.request(appAuthLoginRequest, {
      provider: "personal",
      key: "personal-key",
      flow: "browser",
    });
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
      rpc.peer.request(appAuthLoginRequest, { provider: "work", key: "new-key", flow: "browser" }),
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
