import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemorySecretStore } from "@harness/secrets";
import { PRODUCT_VERSION } from "@harness/release";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { buildServerHarness, type ServerHarness } from "./index.ts";
import {
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appProvidersRequest,
  appSettingsRequest,
} from "./client-protocol.ts";
import * as credentials from "./credential-store.ts";
import { providerEntries } from "./auth.ts";
import { httpGateway, json, sse } from "../../litellm/src/http-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("isolates Mistral environment references and named credentials", async () => {
  vi.stubEnv("MISTRAL_API_KEY", "api-env");
  vi.stubEnv("MISTRAL_VIBE_API_KEY", "vibe-env");
  const secrets = new MemorySecretStore();
  const entries = providerEntries(secrets, {
    providers: { team: { type: "mistral-vibe", config: {} } },
  });
  expect(await entries.get("mistral-api")!.instance.auth?.status()).toMatchObject({
    source: "env",
    detail: "$MISTRAL_API_KEY",
  });
  expect(await entries.get("mistral-vibe")!.instance.auth?.status()).toMatchObject({
    source: "env",
    detail: "$MISTRAL_VIBE_API_KEY",
  });
  expect(await entries.get("team")!.instance.buildProvider()).toBeNull();
  const auth = entries.get("team")!.instance.auth;
  if (auth?.kind !== "api-key") throw new Error("Expected API key auth");
  await auth.submit("team-key");
  expect((await entries.get("team")!.instance.buildProvider())?.provider).toBe("team");
  expect(await secrets.get("provider-instance:team:api-key")).toBe("team-key");
  expect(() =>
    providerEntries(secrets, {
      providers: { team: { type: "mistral-vibe", config: { endpoint: "https://arbitrary.test" } } },
    }),
  ).toThrow();
});

it("signs in both surfaces over RPC, discovers at restart, generates with affinity, and preserves unavailable selections", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-mistral-rpc-"));
  vi.stubEnv("HARNESS_HOME", home);
  for (const env of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_VIBE_API_KEY",
  ])
    vi.stubEnv(env, "");
  const secrets = new MemorySecretStore();
  vi.spyOn(credentials, "credentialStoreForRead").mockResolvedValue({
    store: secrets,
    kind: "dpapi",
  });
  vi.spyOn(credentials, "credentialStoreForLogin").mockResolvedValue({
    store: secrets,
    kind: "dpapi",
  });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      version: 1,
      model: { provider: "mistral-vibe", model: "mistral-vibe-cli-latest" },
      providers: {
        "mistral-vibe": {
          type: "mistral-vibe",
          config: {
            models: {
              "manual-model": { label: "Manual", contextWindow: 524288, maxOutputTokens: 8192 },
              "mistral-vibe-cli-latest": { contextWindow: 131072, maxOutputTokens: 4096 },
            },
          },
        },
        unavailable: { type: "mistral-vibe", config: {} },
        manual: { type: "mistral-vibe", config: { models: { "manual-model": {} } } },
      },
    }),
  );
  const headers: Record<string, unknown>[] = [];
  const gateway = await httpGateway((req, response, raw) => {
    if (req.key === "unavailable-key" || (req.key === "manual-key" && req.method === "GET"))
      return json(response, { error: "private server detail" }, 403);
    if (req.path === "/v1/models")
      return json(response, {
        data: [
          {
            id: "mistral-medium-latest",
            name: "Mistral Medium",
            capabilities: { completion_chat: true, function_calling: true },
            max_context_length: 262144,
          },
        ],
      });
    if (req.path === "/v1/model-catalog?surface=vibe-code")
      return json(response, {
        models: [
          {
            id: "mistral-vibe-cli-latest",
            label: "Mistral Vibe",
            capabilities: { completion_chat: true, function_calling: true },
            max_context_length: 262144,
            parameters: { reasoning: ["off", "high"] },
          },
        ],
      });
    headers.push(raw.headers);
    sse(response, [
      { type: "message.output.delta", id: "reply", content: "Mistral reply" },
      {
        type: "conversation.response.done",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    ]);
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", ((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.startsWith("https://api.mistral.ai/v1/")) throw new Error("Unexpected fixture URL");
    return realFetch(url.replace("https://api.mistral.ai", gateway.url), init);
  }) satisfies typeof fetch);
  let harness: ServerHarness | undefined;
  let client: HarnessClient | undefined;
  async function start() {
    const pair = createInProcessMessageConnectionPair();
    harness = await buildServerHarness(pair.right);
    client = new HarnessClient({
      connection: pair.left,
      client: { name: "mistral-rpc", version: "1" },
    });
    await client.start();
    return client;
  }
  async function restart() {
    await harness!.close();
    client!.closeConnection();
    return start();
  }
  try {
    let rpc = await start();
    expect(
      (await rpc.peer.request(appProvidersRequest, {}))
        .filter(({ type }) => type.startsWith("mistral-"))
        .every(({ catalog }) => catalog === "missing-credentials"),
    ).toBe(true);
    for (const [provider, key] of [
      ["mistral-api", "api-key"],
      ["mistral-vibe", "vibe-key"],
      ["unavailable", "unavailable-key"],
      ["manual", "manual-key"],
    ])
      expect(
        await rpc.peer.request(appAuthLoginRequest, {
          provider: provider!,
          key: key!,
          flow: "browser",
        }),
      ).toEqual({ restartRequired: true });
    expect(gateway.requests).toHaveLength(0);
    rpc = await restart();
    const statuses = await rpc.peer.request(appProvidersRequest, {});
    expect(statuses.find(({ id }) => id === "mistral-api")).toMatchObject({
      registered: true,
      catalog: "ready",
      modelCount: 1,
    });
    expect(statuses.find(({ id }) => id === "mistral-vibe")).toMatchObject({
      registered: true,
      catalog: "ready",
      modelCount: 2,
    });
    expect(statuses.find(({ id }) => id === "unavailable")).toMatchObject({
      registered: true,
      catalog: "failed",
      modelCount: 0,
      diagnostics: ["Mistral catalog returned HTTP 403"],
    });
    expect(JSON.stringify(statuses)).not.toContain("private server detail");
    expect(statuses.find(({ id }) => id === "manual")).toMatchObject({
      registered: true,
      catalog: "degraded",
      modelCount: 1,
      diagnostics: ["Mistral catalog returned HTTP 403"],
    });
    const models = (await rpc.models()).models;
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "mistral-api",
          model: "mistral-medium-latest",
          contextWindow: 262144,
        }),
        expect.objectContaining({
          provider: "mistral-vibe",
          model: "mistral-vibe-cli-latest",
          contextWindow: 131072,
          maxOutputTokens: 4096,
          presets: [
            { value: "off", label: null },
            { value: "high", label: null },
          ],
        }),
        expect.objectContaining({
          provider: "mistral-vibe",
          model: "manual-model",
          label: "Manual",
          contextWindow: 524288,
          maxOutputTokens: 8192,
        }),
        expect.objectContaining({ provider: "manual", model: "manual-model" }),
      ]),
    );
    const degraded = await rpc.create({
      overrides: { model: { provider: "manual", model: "manual-model" } },
    });
    expect(degraded.config.model).toMatchObject({ provider: "manual", model: "manual-model" });
    const conversation = await rpc.create({
      overrides: { model: { provider: "mistral-vibe", model: "manual-model" } },
    });
    await rpc.attach(conversation.id);
    let finished!: (status: string) => void;
    const terminal = new Promise<string>((resolve) => {
      finished = resolve;
    });
    let named!: () => void;
    const titleReady = new Promise<void>((resolve) => {
      named = resolve;
    });
    const unsubscribe = rpc.subscribe((event) => {
      if (
        event.type === "conversation" &&
        event.conversationId === conversation.id &&
        event.event.type === "title.changed" &&
        event.event.title === "Mistral reply"
      )
        named();
      if (
        event.type === "conversation" &&
        event.conversationId === conversation.id &&
        event.event.type === "turn.changed" &&
        event.event.status !== "running"
      )
        finished(event.event.status);
    });
    await rpc.deliver(conversation.id, "hello", "send");
    expect(await terminal).toBe("completed");
    await titleReady;
    unsubscribe();
    expect(headers[0]?.["x-affinity"]).toBe(conversation.id);
    expect(headers[0]?.["user-agent"]).toBe(`Harness/${PRODUCT_VERSION}`);
    expect(gateway.requests.find(({ method }) => method === "POST")?.path).toBe(
      "/v1/conversations",
    );
    const summary = await rpc.usage(conversation.id);
    expect(summary.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 8,
      cachedReadTokens: 160,
    });
    expect(summary.agentContext?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 4,
      cachedReadTokens: 80,
    });
    expect(headers).toHaveLength(2);
    for (const header of headers) expect(header["x-affinity"]).toBe(conversation.id);
    expect(gateway.requests.find(({ method }) => method === "POST")?.body.model).toBe(
      "manual-model",
    );
    const history = (await rpc.history({ conversationId: conversation.id })).entries;
    expect(
      history.find(
        (entry) =>
          entry.kind === "item" && entry.item.type === "message" && entry.item.role === "assistant",
      ),
    ).toMatchObject({
      kind: "item",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Mistral reply" }],
      },
    });
    await rpc.peer.request(appAuthLogoutRequest, { provider: "mistral-vibe" });
    expect(await secrets.get("provider-instance:mistral-vibe:api-key")).toBeNull();
    expect(await secrets.get("provider-instance:mistral-api:api-key")).toBe("api-key");
    rpc = await restart();
    expect((await rpc.models()).models.some(({ provider }) => provider === "mistral-vibe")).toBe(
      false,
    );
    expect((await rpc.peer.request(appSettingsRequest, {})).settings.model?.provider).toBe(
      "mistral-vibe",
    );
  } finally {
    await harness?.close();
    client?.closeConnection();
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});
