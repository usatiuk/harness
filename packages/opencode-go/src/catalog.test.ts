import { afterEach, expect, it, vi } from "vitest";
import { ModelDiscoveryError } from "@harness/protocol";
import { GO_OPENAI_BASE, fetchCatalog, parseCatalog } from "./catalog.ts";
import { OpenCodeGoProvider } from "./provider.ts";

const model = (id = "new-chat") => ({
  id,
  name: "New Chat",
  tool_call: true,
  reasoning: true,
  limit: { context: 100_000, input: 90_000, output: 10_000 },
  reasoning_options: [{ type: "effort", values: ["low", "high"] }],
});
const catalog = (models: Record<string, unknown> = { "new-chat": model() }) => ({
  "opencode-go": { api: GO_OPENAI_BASE, npm: "@ai-sdk/openai-compatible", models },
});
const provider = () =>
  new OpenCodeGoProvider({
    provider: "work-go",
    openai: { client: async () => ({}) as never },
    anthropic: { client: async () => ({}) as never },
  });
afterEach(() => vi.unstubAllGlobals());

it("refreshes a connection-local catalog and exposes fetched limits, labels and presets", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog()));
  vi.stubGlobal("fetch", fetcher);
  const p = provider();
  const other = provider();
  expect(await p.refreshModels(new AbortController().signal)).toEqual({
    status: "ready",
    diagnostics: [],
  });
  expect(p.listModels()).toEqual([
    {
      provider: "work-go",
      model: "new-chat",
      label: "New Chat",
      contextWindow: 100_000,
      maxInputTokens: 90_000,
      maxOutputTokens: 10_000,
      reasoning: { supported: true, effortLevels: ["low", "high"] },
      presets: [{ value: "low" }, { value: "high" }],
    },
  ]);
  expect(() =>
    p.validateConfig({ provider: "work-go", model: "new-chat", preset: "high" }),
  ).not.toThrow();
  expect(() => p.validateConfig({ provider: "work-go", model: "gpt-5.6-luna" })).toThrow(
    "unknown model",
  );
  expect(other.listModels().some((m) => m.model === "gpt-5.6-luna")).toBe(true);
  expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
});

it("retains the last good snapshot after HTTP, invalid JSON, empty and malformed refreshes", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(catalog()));
  vi.stubGlobal("fetch", fetcher);
  const p = provider();
  await p.refreshModels(new AbortController().signal);
  const before = p.listModels();
  for (const response of [
    new Response("remote secret body", { status: 503 }),
    new Response("not json"),
    Response.json(catalog({})),
    Response.json({}),
    Response.json(catalog({ bad: { id: "bad", tool_call: true, limit: { context: -1 } } })),
  ]) {
    fetcher.mockResolvedValueOnce(response);
    await expect(p.refreshModels(new AbortController().signal)).rejects.toBeInstanceOf(
      ModelDiscoveryError,
    );
    expect(p.listModels()).toEqual(before);
  }
});

it("uses the bundled snapshot on initial discovery failure and rejects programming errors", async () => {
  const p = provider();
  const before = p.listModels();
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetcher);
  await expect(p.refreshModels(new AbortController().signal)).rejects.toMatchObject({
    code: "network",
  });
  expect(p.listModels()).toEqual(before);
  fetcher.mockRejectedValueOnce(new Error("programming defect"));
  await expect(p.refreshModels(new AbortController().signal)).rejects.toThrow("programming defect");
});

it("skips invalid, unsupported, deprecated and non-tool rows with bounded diagnostics", () => {
  const parsed = parseCatalog(
    catalog({
      "new-chat": model(),
      google: {
        ...model("google"),
        provider: { api: "https://opencode.ai/inference/go/google/v1beta", npm: "@ai-sdk/google" },
      },
      unsafe: { ...model("unsafe"), provider: { api: "https://attacker.example/v1" } },
      obsolete: { ...model("obsolete"), status: "deprecated" },
      text: { ...model("text"), tool_call: false },
      bad: { ...model("mismatched-id") },
    }),
  );
  expect(parsed.models.map((m) => m.model)).toEqual(["new-chat"]);
  expect(parsed.diagnostics).toEqual([
    "Model 'google' uses an unsupported Go transport",
    "Model 'unsafe' uses an unsupported Go transport",
    "Model 'bad' has invalid Models.dev metadata",
  ]);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`bad-${i}`, {}]));
  expect(parseCatalog(catalog({ ...many, "new-chat": model() })).diagnostics).toHaveLength(20);
});

it("uses the documented SDK route markers rather than model-name prefixes", () => {
  const parsed = parseCatalog(
    catalog({
      "gpt-6-luna": { ...model("gpt-6-luna"), provider: { npm: "@ai-sdk/openai" } },
      "gpt-unqualified": { ...model("gpt-unqualified"), provider: { npm: "@ai-sdk/openai" } },
      grok: { ...model("grok"), provider: { npm: "@ai-sdk/openai" } },
    }),
  );
  expect(parsed.models.map((m) => m.family)).toEqual(["responses", "responses", "responses"]);
  expect(parsed.models[2]?.defaultPreset).toBeUndefined();
});

it("bounds the download and cancels the response reader", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
  );
  await expect(fetchCatalog(new AbortController().signal)).rejects.toMatchObject({ code: "limit" });
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves cancellation and never publishes a cancelled refresh", async () => {
  const p = provider();
  const before = p.listModels();
  const abort = new AbortController();
  const reason = new Error("shutdown");
  vi.stubGlobal("fetch", async () => {
    abort.abort(reason);
    return Response.json(catalog());
  });
  await expect(p.refreshModels(abort.signal)).rejects.toBe(reason);
  expect(p.listModels()).toEqual(before);
});

it("maps fetched metadata into real SDK requests for all three transports", async () => {
  const { default: OpenAI } = await import("openai");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { httpGateway, json, sse } = await import("../../litellm/src/http-fixture.ts");
  const received: { path: string; body: Record<string, unknown>; session: unknown }[] = [];
  const gateway = await httpGateway((req, response, raw) => {
    received.push({ path: req.path, body: req.body, session: raw.headers["x-opencode-session"] });
    if (req.path === "/v1/chat/completions")
      sse(response, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    else if (req.path === "/v1/responses")
      sse(response, [{ type: "response.completed", response: {} }], true);
    else if (req.path === "/v1/messages")
      sse(
        response,
        [
          { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ],
        true,
      );
    else json(response, {}, 404);
  });
  const originalFetch = globalThis.fetch;
  const fetched = catalog({
    "new-chat": model(),
    "gpt-6-luna": {
      ...model("gpt-6-luna"),
      reasoning_options: [{ type: "effort", values: ["medium", "high"] }],
      provider: { npm: "@ai-sdk/openai" },
    },
    "grok-4.7": { ...model("grok-4.7"), provider: { npm: "@ai-sdk/openai" } },
    "muse-spark-1.3-contributor": {
      ...model("muse-spark-1.3-contributor"),
      provider: { npm: "@ai-sdk/openai" },
    },
    "new-messages": {
      ...model("new-messages"),
      limit: { context: 60_000, output: 8_000, input: 50_000 },
      reasoning_options: [{ type: "budget_tokens", max: 4000 }],
      provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/go/anthropic/v1" },
    },
  });
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
    input === "https://models.dev/api.json"
      ? Promise.resolve(Response.json(fetched))
      : originalFetch(input, init),
  );
  try {
    const p = new OpenCodeGoProvider({
      provider: "work-go",
      openai: {
        client: async () =>
          new OpenAI({ apiKey: "fixture", baseURL: `${gateway.url}/v1`, maxRetries: 0 }),
      },
      anthropic: {
        client: async () =>
          new Anthropic({ apiKey: "fixture", baseURL: gateway.url, maxRetries: 0 }),
      },
    });
    await p.refreshModels(new AbortController().signal);
    for (const [model, preset] of [
      ["new-chat", "high"],
      ["gpt-6-luna", undefined],
      ["new-messages", "max"],
      ["grok-4.7", "high"],
      ["muse-spark-1.3-contributor", "high"],
    ]) {
      for await (const event of p.stream(
        {
          instructions: [],
          items: [],
          modelConfig: { provider: "work-go", model: model!, ...(preset ? { preset } : {}) },
        },
        new AbortController().signal,
        { conversationId: "metadata-session" as never },
      ))
        void event;
    }
    expect(received.map((r) => r.path)).toEqual([
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1/responses",
      "/v1/responses",
    ]);
    expect(received.every((r) => r.session === "metadata-session")).toBe(true);
    expect(received[0]?.body).toMatchObject({ model: "new-chat", reasoning_effort: "high" });
    expect(received[1]?.body).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "medium" },
      store: false,
    });
    expect(received[3]?.body).toMatchObject({ model: "grok-4.7", reasoning: { effort: "high" } });
    expect(received[4]?.body).toMatchObject({
      model: "muse-spark-1.3-contributor",
      reasoning: { effort: "high" },
    });
    expect(received[2]?.body).toMatchObject({
      model: "new-messages",
      max_tokens: 8_000,
      thinking: { type: "enabled", budget_tokens: 3999 },
    });
  } finally {
    await gateway.close();
  }
});
