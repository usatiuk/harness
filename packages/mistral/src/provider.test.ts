import { PRODUCT_VERSION } from "@harness/release";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { ContextWindowExceededError, ModelDiscoveryError } from "@harness/protocol";
import { httpGateway, json, sse } from "../../litellm/src/http-fixture.ts";
import { MistralProvider } from "./provider.ts";
import { fetchCatalog, parseCatalog } from "./catalog.ts";
import { configuredModelsSchema, type ConfiguredModel } from "./config.ts";

const gateways: Awaited<ReturnType<typeof httpGateway>>[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});
const signal = new AbortController().signal;
const fetchUrl = (input: Parameters<typeof fetch>[0]) =>
  new URL(input instanceof Request ? input.url : input);
const context = { conversationId: "child" as ConversationId };
const apiRow = {
  id: "coding",
  name: "Coding",
  aliases: ["coding-latest"],
  max_context_length: 262144,
  default_model_temperature: 0.3,
  capabilities: { completion_chat: true, function_calling: true, vision: true },
};
const vibeRow = {
  ...apiRow,
  label: "Vibe coding",
  parameters: { temperature: 0.2, reasoning: ["off", "high"] },
};
const catalog = (mode: "api" | "vibe") =>
  mode === "api" ? { data: [apiRow] } : { models: [vibeRow] };
const request = (mode: "api" | "vibe" = "vibe"): ModelRequest => ({
  instructions: [{ type: "text", text: "Stable system" }],
  items: [],
  prompt: "Use echo",
  tools: [
    {
      kind: "function",
      name: "echo",
      description: "Echo",
      parameters: { type: "object", properties: { x: { type: "number" } } },
    },
  ],
  modelConfig: {
    provider: "work",
    model: "coding",
    ...(mode === "vibe" ? { preset: "high" } : {}),
  },
});
async function collect(provider: MistralProvider, req = request(), abort = signal) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(req, abort, context)) events.push(event);
  return events;
}
function item(fields: Record<string, unknown>, seq: number): Item {
  return {
    id: "item-" + seq,
    conversationId: "child",
    turnId: "turn",
    seq,
    parent: null,
    createdAt: seq,
    ...fields,
  } as Item;
}
function continuation(first: ModelStreamEvent[], base: ModelRequest): ModelRequest {
  const items: ModelRequest["items"] = [
    {
      item: item(
        { type: "message", role: "user", content: [{ type: "text", text: base.prompt }] },
        0,
      ),
    },
  ];
  for (const event of first) {
    if (event.type !== "message" && event.type !== "reasoning" && event.type !== "tool_call")
      continue;
    const { payload, ...output } = event;
    const canonical = item(
      { ...output, ...(output.type === "message" ? { role: "assistant" } : {}) },
      items.length,
    );
    items.push({
      item: canonical,
      ...(payload ? { payload: { ...payload, itemId: canonical.id } } : {}),
    });
  }
  for (const event of first)
    if (event.type === "tool_call")
      items.push({
        item: item(
          {
            type: "tool_result",
            callId: event.callId,
            status: "ok",
            content: [{ type: "text", text: "echoed" }],
          },
          items.length,
        ),
      });
  const next = { ...base, items };
  delete next.prompt;
  return next;
}
async function fixture(
  mode: "api" | "vibe",
  models: Record<string, ConfiguredModel> = {},
  data: unknown = catalog(mode),
) {
  const gateway = await httpGateway((req, response) => {
    if (req.method === "GET") return json(response, data);
    sse(response, [{ type: "response.completed", response: {} }]);
  });
  gateways.push(gateway);
  const provider = new MistralProvider(
    "work",
    mode,
    "key",
    (input, init) =>
      fetch(new URL(fetchUrl(input).pathname + fetchUrl(input).search, gateway.url), init),
    models,
  );
  await provider.refreshModels(signal);
  return { provider, gateway };
}

describe("Mistral Responses", () => {
  it.each(["api", "vibe"] as const)(
    "streams plaintext reasoning and replays it with linked local calls on %s",
    async (mode) => {
      const reasoning = {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [{ type: "reasoning_text", text: "Need to call echo." }],
      };
      const call = {
        type: "function_call",
        id: "fc_1",
        call_id: "abc123XYZ",
        name: "echo",
        arguments: '{"x":42}',
      };
      const usage = {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        ...(mode === "vibe" ? { input_tokens_details: { cached_tokens: 0 } } : {}),
      };
      const headers: Record<string, unknown>[] = [];
      const gateway = await httpGateway((req, response, raw) => {
        if (req.method === "GET") return json(response, catalog(mode));
        headers.push(raw.headers);
        sse(response, [
          { type: "response.reasoning_text.delta", delta: "Need to call echo." },
          { type: "response.output_item.done", item: reasoning },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { usage } },
        ]);
      });
      gateways.push(gateway);
      const provider = new MistralProvider("work", mode, "fixture-key", (input, init) =>
        fetch(new URL(fetchUrl(input).pathname + fetchUrl(input).search, gateway.url), init),
      );
      await provider.refreshModels(signal);
      const base = { ...request(mode), providerOptions: { webSearch: true }, maxOutputTokens: 256 };
      const first = await collect(provider, base);
      expect(first).toMatchObject([
        { type: "reasoning_delta", text: "Need to call echo." },
        { type: "reasoning", content: [{ type: "text", text: "Need to call echo." }] },
        { type: "tool_call", callId: call.call_id, name: "echo", args: { x: 42 } },
        { type: "completed", usage: { cachedReadTokens: 0 }, providerUsage: usage },
      ]);
      expect(first.at(-1)).toEqual({
        type: "completed",
        usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0 },
        providerUsage: usage,
      });
      await collect(provider, continuation(first, base));
      const posts = gateway.requests.filter(({ method }) => method === "POST");
      expect(posts.map(({ path }) => path)).toEqual(["/v1/responses", "/v1/responses"]);
      for (const { body } of posts) {
        expect(body).toMatchObject({
          model: "coding",
          instructions: "Stable system",
          prompt_cache_key: context.conversationId,
          temperature: mode === "api" ? 0.3 : 0.2,
          max_output_tokens: 256,
          stream: true,
          store: false,
          tools: [{ type: "function", name: "echo" }],
        });
        if (mode === "vibe") expect(body.reasoning).toEqual({ effort: "high" });
      }
      expect(posts[1]!.body.input).toMatchObject([
        { role: "user" },
        reasoning,
        { type: "function_call", call_id: call.call_id, arguments: call.arguments },
        { type: "function_call_output", call_id: call.call_id },
      ]);
      for (const header of headers) {
        expect(header["x-affinity"]).toBe(context.conversationId);
        expect(header["user-agent"]).toBe(`Harness/${PRODUCT_VERSION}`);
      }
    },
  );

  it("normalizes context overflow without trying a second endpoint", async () => {
    const paths: string[] = [];
    const provider = new MistralProvider(
      "work",
      "api",
      "key",
      async (input) => {
        paths.push(fetchUrl(input).pathname);
        return Response.json(
          { error: { message: "context length exceeded", code: "context_length_exceeded" } },
          { status: 400 },
        );
      },
      { coding: {} },
    );
    await expect(collect(provider, request("api"))).rejects.toBeInstanceOf(
      ContextWindowExceededError,
    );
    expect(paths).toEqual(["/v1/responses"]);
  });
});

describe("Mistral catalog boundary", () => {
  it.each(["api", "vibe"] as const)(
    "merges configured metadata per exact ID on %s",
    async (mode) => {
      let raw: unknown = catalog(mode);
      const provider = new MistralProvider("work", mode, "key", async () => Response.json(raw), {
        coding: { contextWindow: 524288, maxOutputTokens: 8192 },
        "coding-latest": { label: "Alias override" },
        manual: { contextWindow: 10000, maxOutputTokens: 1000 },
      });
      expect(provider.listModels().map(({ model }) => model)).toEqual([
        "coding",
        "coding-latest",
        "manual",
      ]);
      await provider.refreshModels(signal);
      const discovered = provider.listModels();
      expect(discovered.find(({ model }) => model === "coding")).toMatchObject({
        label: mode === "vibe" ? "Vibe coding" : "Coding",
        contextWindow: 524288,
        maxOutputTokens: 8192,
      });
      expect(discovered.find(({ model }) => model === "coding-latest")).toMatchObject({
        label: "Alias override",
        contextWindow: 262144,
      });
      if (mode === "vibe")
        expect(discovered[0]?.presets).toEqual([{ value: "off" }, { value: "high" }]);
      raw = mode === "api" ? { data: [{ invalid: true }] } : { models: [{ invalid: true }] };
      await expect(provider.refreshModels(signal)).rejects.toBeInstanceOf(ModelDiscoveryError);
      expect(provider.listModels()).toEqual(discovered);
      raw = mode === "api" ? { data: [] } : { models: [] };
      await provider.refreshModels(signal);
      expect(provider.listModels().find(({ model }) => model === "coding-latest")).toEqual({
        provider: "work",
        model: "coding-latest",
        label: "Alias override",
      });
      expect(provider.listModels().find(({ model }) => model === "manual")?.maxOutputTokens).toBe(
        1000,
      );
    },
  );

  it("rejects capacity conflicts introduced by discovery without publishing the snapshot", async () => {
    const provider = new MistralProvider(
      "work",
      "api",
      "key",
      async () => Response.json(catalog("api")),
      {
        coding: { maxOutputTokens: 524288 },
      },
    );
    const before = provider.listModels();
    await expect(provider.refreshModels(signal)).rejects.toThrow(
      "maxOutputTokens cannot exceed contextWindow",
    );
    expect(provider.listModels()).toEqual(before);
  });

  it("bounds the combined catalog and retains configured entries after discovery failure", async () => {
    let response = new Response(null, { status: 503 });
    const provider = new MistralProvider("work", "api", "key", async () => response, {
      manual: {},
    });
    await expect(provider.refreshModels(signal)).rejects.toMatchObject({
      code: "http",
      status: 503,
    });
    expect(provider.listModels()).toEqual([{ provider: "work", model: "manual" }]);
    response = Response.json({
      data: Array.from({ length: 5000 }, (_, i) => ({
        ...apiRow,
        id: `model-${i}`,
        aliases: [],
      })),
    });
    await expect(provider.refreshModels(signal)).rejects.toMatchObject({ code: "limit" });
    expect(provider.listModels()).toEqual([{ provider: "work", model: "manual" }]);
  });
  it("exposes verified Vibe presets, excludes unsupported models and reports bad metadata", () => {
    const parsed = parseCatalog(
      {
        models: [
          vibeRow,
          { ...vibeRow, id: "bad", label: 1 },
          { ...vibeRow, id: "embed", capabilities: { function_calling: false } },
          { ...vibeRow, id: "future", aliases: [], parameters: { reasoning: ["new"] } },
        ],
      },
      "vibe",
      "work",
    );
    expect([...parsed.entries.keys()]).toEqual(["coding", "coding-latest", "future"]);
    expect(parsed.entries.get("coding")?.info).toMatchObject({
      presets: [{ value: "off" }, { value: "high" }],
      reasoning: { supported: true, effortLevels: ["off", "high"] },
    });
    expect(parsed.entries.get("future")?.info.presets).toEqual([{ value: "new" }]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(() => parseCatalog({ models: [{ ...vibeRow, label: 1 }] }, "vibe", "work")).toThrow(
      ModelDiscoveryError,
    );
    expect(() => parseCatalog({ data: [apiRow, apiRow] }, "api", "work")).toThrow("duplicate");
    expect(() =>
      parseCatalog({ data: Array.from({ length: 5001 }, () => apiRow) }, "api", "work"),
    ).toThrow(ModelDiscoveryError);
    expect(() =>
      parseCatalog(
        { data: [{ ...apiRow, aliases: Array.from({ length: 5000 }, (_, i) => `alias-${i}`) }] },
        "api",
        "work",
      ),
    ).toThrow("including aliases");
  });
  it.each(["api", "vibe"] as const)(
    "retains advertised %s reasoning capability without inventing presets",
    (mode) => {
      const row = mode === "api" ? apiRow : { ...vibeRow, parameters: {} };
      for (const reasoning of [true, false]) {
        const { entries } = parseCatalog(
          {
            [mode === "api" ? "data" : "models"]: [
              { ...row, capabilities: { ...row.capabilities, reasoning } },
            ],
          },
          mode,
          "work",
        );
        expect(entries.get("coding")?.info.reasoning).toEqual({ supported: reasoning });
        expect(entries.get("coding")?.info.presets).toBeUndefined();
      }
    },
  );
  it("publishes atomic snapshots and preserves the previous catalog on failure", async () => {
    let raw: unknown = catalog("api");
    const provider = new MistralProvider("work", "api", "key", async () => Response.json(raw));
    await provider.refreshModels(signal);
    const before = provider.listModels();
    before[0]!.model = "mutated";
    raw = { data: [{ invalid: true }] };
    await expect(provider.refreshModels(signal)).rejects.toBeInstanceOf(ModelDiscoveryError);
    expect(provider.listModels()[0]?.model).toBe("coding");
    raw = { data: [] };
    await provider.refreshModels(signal);
    expect(provider.listModels()).toEqual([]);
  });
  it("gives explicit model rows precedence over aliases and rejects ambiguous aliases", () => {
    const explicit = { ...apiRow, id: "coding-latest", name: "Explicit", aliases: [] };
    for (const data of [
      [apiRow, explicit],
      [explicit, apiRow],
    ]) {
      const { entries } = parseCatalog({ data }, "api", "work");
      expect(entries.get("coding-latest")?.info.label).toBe("Explicit");
    }
    const unsupported = { ...explicit, capabilities: { function_calling: false } };
    const { entries } = parseCatalog({ data: [apiRow, unsupported] }, "api", "work");
    expect([...entries.keys()]).toEqual(["coding"]);
    expect(() =>
      parseCatalog({ data: [apiRow, { ...apiRow, id: "other" }] }, "api", "work"),
    ).toThrow("conflicting aliases");
  });
  it("bounds response bytes and rejects redirects without forwarding a credential", async () => {
    const gateway = await httpGateway((_req, response) => {
      response.writeHead(302, { location: "/leak" });
      response.end("private body");
    });
    gateways.push(gateway);
    await expect(
      fetchCatalog("api", "secret", signal, (input, init) =>
        fetch(
          (input instanceof Request ? input.url : input.toString()).replace(
            "https://api.mistral.ai",
            gateway.url,
          ),
          init,
        ),
      ),
    ).rejects.toMatchObject({ code: "http", status: 302 });
    expect(gateway.requests).toHaveLength(1);
    await expect(
      fetchCatalog("api", "key", signal, async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
    ).rejects.toMatchObject({ code: "limit" });
  });
  it("classifies only transport failures and preserves defects racing cancellation", async () => {
    const network = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    });
    await expect(
      fetchCatalog("api", "key", signal, async () => {
        throw network;
      }),
    ).rejects.toMatchObject({ code: "network" });
    const controller = new AbortController();
    const defect = new TypeError("programming defect");
    await expect(
      fetchCatalog("api", "key", controller.signal, async () => {
        controller.abort();
        throw defect;
      }),
    ).rejects.toBe(defect);
    await expect(fetchCatalog("api", "key", controller.signal, fetch)).rejects.toBe(
      controller.signal.reason,
    );
  });
});

it("preserves imported IDs exactly and leaves selected context at its original cache position", async () => {
  const base = request("api");
  delete base.prompt;
  base.items = [
    {
      item: item({ type: "message", role: "user", content: [{ type: "text", text: "start" }] }, 0),
    },
    {
      item: item(
        { type: "tool_call", callId: "other-provider-id", name: "echo", args: { x: 1 } },
        1,
      ),
    },
    {
      item: item(
        { type: "tool_result", callId: "other-provider-id", status: "ok", content: [] },
        2,
      ),
    },
    {
      item: item(
        { type: "context", key: "status", content: [{ type: "text", text: "changes" }] },
        3,
      ),
    },
  ];
  const { provider, gateway } = await fixture("api");
  await collect(provider, base);
  await collect(provider, base);
  const wire = gateway.requests.at(-1)!.body;
  const input = wire.input as unknown[];
  expect(wire.instructions).toBe("Stable system");
  expect(input.at(-1)).toEqual({ role: "developer", content: "changes" });
  const id = "other-provider-id";

  expect(input[1]).toMatchObject({ type: "function_call", call_id: id });
  expect(input[2]).toMatchObject({ type: "function_call_output", call_id: id });
  expect(gateway.requests.at(-2)?.body).toEqual(wire);
});

it.each(["api", "vibe"] as const)(
  "preserves true, false and unknown image claims for %s aliases",
  async (mode) => {
    const rows = [true, false, undefined].map((vision, index) => ({
      ...apiRow,
      ...(mode === "vibe" ? { label: "Vision" } : {}),
      id: `vision-${index}`,
      aliases: [`alias-${index}`],
      capabilities: { function_calling: true, ...(vision !== undefined ? { vision } : {}) },
    }));
    const { provider } = await fixture(
      mode,
      {},
      mode === "api" ? { data: rows } : { models: rows },
    );
    expect(
      provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
    ).toEqual([
      { model: "vision-0", supportsImages: true },
      { model: "alias-0", supportsImages: true },
      { model: "vision-1", supportsImages: false },
      { model: "alias-1", supportsImages: false },
      { model: "vision-2", supportsImages: undefined },
      { model: "alias-2", supportsImages: undefined },
    ]);
  },
);

it.each(["api", "vibe"] as const)(
  "lets configured image support override %s discovery per exact ID",
  async (mode) => {
    const rows = [true, false].map((vision, index) => ({
      ...apiRow,
      id: `remote-${index}`,
      aliases: [],
      ...(mode === "vibe" ? { label: "Configured vision" } : {}),
      capabilities: { function_calling: true, vision },
    }));
    const { provider } = await fixture(
      mode,
      configuredModelsSchema.parse({
        "remote-0": { supportsImages: false },
        "remote-1": { supportsImages: true },
        configured: { supportsImages: true },
        unknown: {},
      }),
      mode === "api" ? { data: rows } : { models: rows },
    );
    expect(
      provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
    ).toEqual([
      { model: "remote-0", supportsImages: false },
      { model: "remote-1", supportsImages: true },
      { model: "configured", supportsImages: true },
      { model: "unknown", supportsImages: undefined },
    ]);
  },
);

it.each(["api", "vibe"] as const)(
  "uses configured editing metadata after %s discovery",
  async (mode) => {
    const { provider } = await fixture(mode, {
      manual: { preferredEditTool: "patch", reasoning: { supported: false }, maxInputTokens: 1234 },
    });
    expect(provider.listModels().find((entry) => entry.model === "manual")).toEqual({
      provider: "work",
      model: "manual",
      preferredEditTool: "patch",
      reasoning: { supported: false },
      maxInputTokens: 1234,
    });
    expect(provider.capabilities("manual")).toMatchObject({
      preferredEditTool: "patch",
      customToolInput: { supported: false, grammars: [] },
    });
  },
);

it.each(["api", "vibe"] as const)(
  "delivers configured-only reasoning and sampling controls on %s",
  async (mode) => {
    const { provider, gateway } = await fixture(mode, {
      manual: { temperature: 0.4, reasoning: { supported: true, effortLevels: ["off", "high"] } },
      coding: { temperature: 0.2, reasoning: { supported: true, effortLevels: ["low"] } },
      "coding-latest": { reasoning: { supported: false } },
    });
    expect(provider.listModels().find((entry) => entry.model === "manual")).toMatchObject({
      presets: [{ value: "off" }, { value: "high" }],
    });
    for (const [model, preset, temperature, reasoning_effort] of [
      ["manual", "off", 0.4, "none"],
      ["coding", "low", 0.2, "low"],
    ] as const) {
      await collect(provider, {
        ...request(mode),
        modelConfig: { provider: "work", model, preset },
      });
      expect(gateway.requests.at(-1)?.body).toMatchObject({
        temperature,
        reasoning: { effort: reasoning_effort },
      });
    }
    expect(() =>
      provider.validateConfig({ provider: "work", model: "manual", preset: "low" }),
    ).toThrow("Unknown preset");
    expect(() =>
      provider.validateConfig({ provider: "work", model: "coding-latest", preset: "high" }),
    ).toThrow("Unknown preset");
  },
);
