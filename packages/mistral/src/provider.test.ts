import { PRODUCT_VERSION } from "@harness/release";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { ContextWindowExceededError, ModelDiscoveryError } from "@harness/protocol";
import { httpGateway, json, sse } from "../../litellm/src/http-fixture.ts";
import { MistralProvider } from "./provider.ts";
import { fetchCatalog, parseCatalog } from "./catalog.ts";
import { buildMistralRequest } from "./request.ts";
import { mistralEvents } from "./stream.ts";
import { configuredModelsSchema, type ConfiguredModel } from "./config.ts";

const gateways: Awaited<ReturnType<typeof httpGateway>>[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});
const signal = new AbortController().signal;
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
const message = (content: unknown, content_index = 0, output_index = 0) => ({
  type: "message.output.delta",
  id: "msg-" + output_index,
  output_index,
  content_index,
  content,
});
const call = (args: string, output_index = 1, tool_call_id = "abc123XYZ") => ({
  type: "function.call.delta",
  id: "call-" + output_index,
  output_index,
  tool_call_id,
  name: "echo",
  arguments: args,
});
const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 80 },
};
const done = (reported: unknown = usage) => ({
  type: "conversation.response.done",
  usage: reported,
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
  events: unknown[],
  status = 200,
  search = false,
  models: Record<string, ConfiguredModel> = {},
  rawCatalog: unknown = catalog(mode),
) {
  const headers: Record<string, unknown>[] = [];
  const gateway = await httpGateway((req, response, raw) => {
    headers.push(raw.headers);
    if (req.method === "GET") return json(response, rawCatalog);
    expect(req.path).toBe("/v1/conversations");
    if ((req.body.inputs as Record<string, unknown>[]).some((entry) => "id" in entry))
      return json(response, { message: "Input entries send by the user can't specify ids" }, 422);
    if (status !== 200)
      return json(
        response,
        { error: { message: "context length exceeded", code: "context_length_exceeded" } },
        status,
      );
    sse(response, events, true);
  });
  gateways.push(gateway);
  const provider = new MistralProvider(
    "work",
    mode,
    "fixture-key",
    (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url.startsWith("https://api.mistral.ai/v1/")).toBe(true);
      return fetch(url.replace("https://api.mistral.ai", gateway.url), init);
    },
    search,
    models,
  );
  await provider.refreshModels(signal);
  return { provider, gateway, headers };
}

describe("Mistral native delivery", () => {
  it.each([
    ["mistral-small-latest", ["none", "high"]],
    ["mistral-medium-3-5", ["none", "high"]],
    ["mistral-large-4-0", ["none", "high"]],
    ["zai-glm-5-3", ["low", "high", "max"]],
  ] as const)("exposes and delivers documented API reasoning for %s", async (alias, levels) => {
    const { provider, gateway } = await fixture(
      "api",
      [message("reply"), done()],
      200,
      false,
      {},
      {
        data: [
          {
            ...apiRow,
            aliases: [alias],
            capabilities: { ...apiRow.capabilities, reasoning: true },
          },
        ],
      },
    );
    expect(provider.listModels().map((model) => model.presets)).toEqual([
      levels.map((value) => ({ value })),
      levels.map((value) => ({ value })),
    ]);
    for (const preset of levels) {
      await collect(provider, {
        ...request("api"),
        modelConfig: { provider: "work", model: alias, preset },
      });
      expect(gateway.requests.at(-1)?.body.completion_args).toMatchObject({
        reasoning_effort: preset,
      });
    }
    await collect(provider, request("api"));
    expect(gateway.requests.at(-1)?.body.completion_args).not.toHaveProperty("reasoning_effort");
    expect(() =>
      provider.validateConfig({ provider: "work", model: alias, preset: "adaptive" }),
    ).toThrow("Unknown preset");
  });
  it.each(["api", "vibe"] as const)(
    "replays assistant-only output without entry IDs on %s",
    async (mode) => {
      const { provider, gateway } = await fixture(mode, [message("reply"), done()]);
      const base = request(mode);
      const first = await collect(provider, base);
      const next = { ...continuation(first, base), prompt: "Follow up" };
      expect((await collect(provider, next)).at(-1)?.type).toBe("completed");
      expect(gateway.requests.at(-1)?.body.inputs).toEqual([
        { type: "message.input", role: "user", content: "Use echo" },
        { type: "message.output", role: "assistant", content: [{ type: "text", text: "reply" }] },
        { type: "message.input", role: "user", content: "Follow up" },
      ]);
      expect(first.find((event) => event.type === "message")).toMatchObject({
        payload: { payload: [{ id: "msg-0" }] },
      });
    },
  );
  it("exposes and delivers advertised Vibe reasoning controls without collapsing efforts", async () => {
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive", "off"];
    const { provider, gateway } = await fixture(
      "vibe",
      [message("reply"), done()],
      200,
      false,
      {},
      {
        models: [{ ...vibeRow, parameters: { reasoning: [...levels, "high"] } }],
      },
    );
    expect(provider.listModels().map((model) => model.presets)).toEqual([
      levels.map((value) => ({ value })),
      levels.map((value) => ({ value })),
    ]);
    expect(await provider.refreshModels(signal)).toMatchObject({
      status: "ready",
      diagnostics: [],
    });
    for (const preset of levels) {
      await collect(provider, {
        ...request(),
        modelConfig: { provider: "work", model: "coding-latest", preset },
      });
      expect(gateway.requests.at(-1)?.body.completion_args).toMatchObject({
        reasoning_effort: preset === "off" ? "none" : preset,
      });
    }
    await collect(provider, request("api"));
    expect(gateway.requests.at(-1)?.body.completion_args).not.toHaveProperty("reasoning_effort");
    await expect(
      collect(provider, {
        ...request(),
        modelConfig: { provider: "work", model: "coding", preset: "unadvertised" },
      }),
    ).rejects.toThrow("Unknown preset");
  });
  it.each(["api", "vibe"] as const)("generates a configured-only model on %s", async (mode) => {
    const { provider, gateway } = await fixture(
      mode,
      [message("manual reply"), done()],
      200,
      false,
      {
        manual: { label: "Manual", contextWindow: 262144, maxOutputTokens: 8192 },
      },
    );
    const req = { ...request(mode), modelConfig: { provider: "work", model: "manual" } };
    expect((await collect(provider, req)).at(-1)?.type).toBe("completed");
    expect(gateway.requests.find(({ method }) => method === "POST")?.body).toMatchObject({
      model: "manual",
      store: false,
    });
    expect(provider.listModels().find(({ model }) => model === "manual")).toEqual({
      provider: "work",
      model: "manual",
      label: "Manual",
      contextWindow: 262144,
      maxOutputTokens: 8192,
    });
    expect(() => provider.validateConfig({ ...req.modelConfig, preset: "high" })).toThrow(
      "Unknown preset",
    );
  });
  it("streams and replays signed thinking, exact call arguments and stable prefixes over real HTTP/SSE", async () => {
    const firstBlock = {
      type: "thinking",
      thinking: [{ type: "text", text: "Think", annotation: "opaque" }],
      signature: "sig-1",
      closed: true,
      vendor: { value: 1 },
    };
    const secondBlock = {
      type: "thinking",
      thinking: [{ type: "text", text: "Again" }],
      signature: "sig-2",
      closed: true,
    };
    const rawArgs = '{ "x" : 1 }';
    const { provider, gateway, headers } = await fixture("vibe", [
      message({ ...firstBlock, signature: null, closed: false }),
      message({ ...firstBlock, thinking: [] }),
      message("Between", 1),
      message(secondBlock, 2),
      call(rawArgs.slice(0, 5)),
      call(rawArgs.slice(5)),
      done(),
    ]);
    const base = request();
    base.maxOutputTokens = 1234;
    const first = await collect(provider, base);
    expect(first.filter((e) => e.type === "reasoning_delta").map((e) => e.text)).toEqual([
      "Think",
      "Again",
    ]);
    expect(first.at(-1)).toMatchObject({
      type: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80 },
    });
    await collect(provider, continuation(first, base));
    const [a, b] = gateway.requests.filter((req) => req.method === "POST").map((req) => req.body);
    expect(a).toMatchObject({
      model: "coding",
      instructions: "Stable system",
      stream: true,
      store: false,
      completion_args: { reasoning_effort: "high", temperature: 0.2, max_tokens: 1234 },
    });
    expect((b!.inputs as unknown[]).slice(0, (a!.inputs as unknown[]).length)).toEqual(a!.inputs);
    expect((b!.inputs as unknown[]).slice(1)).toEqual([
      {
        type: "message.output",
        role: "assistant",
        content: [firstBlock, { type: "text", text: "Between" }, secondBlock],
      },
      {
        type: "function.call",
        tool_call_id: "abc123XYZ",
        name: "echo",
        arguments: rawArgs,
      },
      { type: "function.result", tool_call_id: "abc123XYZ", result: "echoed" },
    ]);
    expect(b!.tools).toEqual(a!.tools);
    expect(
      headers
        .slice(1)
        .every(
          (h) => h["x-affinity"] === "child" && h["user-agent"] === `Harness/${PRODUCT_VERSION}`,
        ),
    ).toBe(true);
    expect(gateway.requests.map((r) => r.key)).toEqual([
      "fixture-key",
      "fixture-key",
      "fixture-key",
    ]);
    expect(gateway.requests[0]?.path).toBe("/v1/model-catalog?surface=vibe-code");
  });
  it.each(["api", "vibe"] as const)(
    "keeps %s on Conversations with search enabled or disabled",
    async (mode) => {
      for (const search of [false, true]) {
        const { provider, gateway } = await fixture(
          mode,
          [
            ...(search
              ? [
                  {
                    type: "tool.execution.started",
                    id: "search",
                    name: "web_search",
                    output_index: 0,
                  },
                ]
              : []),
            message("[Source](https://example.com)"),
            done(),
          ],
          200,
          search,
        );
        const req = { ...request(mode), providerOptions: provider.providerOptions };
        const events = await collect(provider, req);
        expect(gateway.requests[1]?.body).toMatchObject({ stream: true, store: false });
        expect(gateway.requests[1]?.body.tools).toEqual([
          {
            type: "function",
            function: {
              name: "echo",
              description: "Echo",
              parameters: { type: "object", properties: { x: { type: "number" } } },
            },
          },
          ...(search ? [{ type: "web_search" }] : []),
        ]);
        expect(events.find((e) => e.type === "message")).toMatchObject({
          content: [{ type: "text", text: "[Source](https://example.com)" }],
        });
        if (search) {
          expect(events.find((e) => e.type === "provider_output")).not.toHaveProperty("payload");
          expect(events.at(-1)).toMatchObject({
            costIncomplete: true,
            inputTokensAreContext: false,
          });
        }
      }
    },
  );
  it("preserves the API catalog, unknown counts and validation of catalog controls", async () => {
    const { provider, gateway } = await fixture("api", [
      message("done"),
      done({ prompt_tokens: 10 }),
    ]);
    expect(provider.listModels()).toEqual([
      {
        provider: "work",
        model: "coding",
        label: "Coding",
        contextWindow: 262144,
        supportsImages: true,
      },
      {
        provider: "work",
        model: "coding-latest",
        label: "Coding",
        contextWindow: 262144,
        supportsImages: true,
      },
    ]);
    expect(provider.capabilities("coding")).toEqual({
      contentTypes: ["text", "image"],
      toolCalling: true,
      customToolInput: { supported: false, grammars: [] },
      preferredEditTool: "replace",
    });
    expect((await collect(provider, request("api"))).at(-1)).toMatchObject({
      type: "completed",
      usage: null,
    });
    expect(gateway.requests[0]?.path).toBe("/v1/models");
    expect(gateway.requests[1]?.body.completion_args).not.toHaveProperty("reasoning_effort");
    await expect(collect(provider)).rejects.toThrow("Unknown preset");
    await expect(
      collect(provider, { ...request("api"), modelConfig: { provider: "other", model: "coding" } }),
    ).rejects.toThrow("identity mismatch");
  });
  it("assembles interleaved local calls without concatenating their repeated names or IDs", async () => {
    const { provider } = await fixture("api", [
      call('{"x":', 1),
      call('{"x":2}', 2, "another-id"),
      call("1}", 1),
      done(),
    ]);
    const calls = (await collect(provider, request("api"))).filter((e) => e.type === "tool_call");
    expect(calls).toMatchObject([
      { callId: "abc123XYZ", name: "echo", args: { x: 1 } },
      { callId: "another-id", name: "echo", args: { x: 2 } },
    ]);
  });
  it("retains terminal accounting and readable output on malformed local calls, without dispatch", async () => {
    const { provider } = await fixture("api", [message("partial"), call("{bad"), done()]);
    const events = await collect(provider, request("api"));
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    expect(events.find((e) => e.type === "message")).not.toHaveProperty("payload");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      usage: { inputTokens: 100 },
      error: expect.stringContaining("malformed") as unknown,
    });
  });
  it("rejects invalid accounting and EOF without fabricating successful completion", async () => {
    const invalid = await fixture("api", [
      done({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } }),
    ]);
    await expect(collect(invalid.provider, request("api"))).rejects.toThrow();
    const truncated = await fixture("api", [message("partial"), call("{")]);
    await expect(collect(truncated.provider, request("api"))).rejects.toThrow(
      "without response completion",
    );
  });
  it("drains partial readable content without signed metadata after a provider error", async () => {
    const { provider } = await fixture("api", [
      message({ type: "thinking", thinking: [{ type: "text", text: "partial" }], signature: null }),
      call("{"),
      { type: "conversation.response.error", message: "Interrupted", code: 500 },
    ]);
    const events = await collect(provider, request("api"));
    expect(events).toEqual([
      { type: "reasoning_delta", text: "partial" },
      { type: "reasoning", content: [{ type: "text", text: "partial" }] },
      { type: "completed", usage: null, error: "Mistral response error (500): Interrupted" },
    ]);
  });
  it("normalizes native context overflow before output", async () => {
    const { provider } = await fixture("api", [], 400);
    await expect(collect(provider, request("api"))).rejects.toBeInstanceOf(
      ContextWindowExceededError,
    );
  });
  it("drains authoritative completion even if cancellation arrives while final output is yielded", async () => {
    const controller = new AbortController();
    const stream = (async function* () {
      yield message("received");
      yield done();
      throw new Error("must stop at terminal event");
    })();
    const events: ModelStreamEvent[] = [];
    for await (const event of mistralEvents(stream, "work", "coding", controller.signal)) {
      events.push(event);
      if (event.type === "message") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "completed", usage: { inputTokens: 100 } });
    expect(events.find((e) => e.type === "message")).toHaveProperty("payload");
  });
  it.each(["abort", "return"])("closes the real streaming socket on consumer %s", async (kind) => {
    let disconnected!: () => void;
    const drained = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const gateway = await httpGateway((req, response) => {
      if (req.method === "GET") return json(response, catalog("api"));
      response.on("close", disconnected);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        "event: message.output.delta\ndata: " + JSON.stringify(message("started")) + "\n\n",
      );
    });
    gateways.push(gateway);
    const provider = new MistralProvider("work", "api", "key", (input, init) =>
      fetch(
        (input instanceof Request ? input.url : input.toString()).replace(
          "https://api.mistral.ai",
          gateway.url,
        ),
        init,
      ),
    );
    await provider.refreshModels(signal);
    const controller = new AbortController();
    const iterator = provider
      .stream(request("api"), controller.signal, context)
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "started" });
    if (kind === "abort") {
      const reason = new Error("cancelled by test");
      const pending = iterator.next();
      controller.abort(reason);
      expect((await pending).value).toEqual({
        type: "message",
        content: [{ type: "text", text: "started" }],
      });
      await expect(iterator.next()).rejects.toBe(reason);
    } else await iterator.return?.();
    await drained;
  });
});
describe("Mistral catalog boundary", () => {
  it.each(["api", "vibe"] as const)(
    "merges configured metadata per exact ID on %s",
    async (mode) => {
      let raw: unknown = catalog(mode);
      const provider = new MistralProvider(
        "work",
        mode,
        "key",
        async () => Response.json(raw),
        false,
        {
          coding: { contextWindow: 524288, maxOutputTokens: 8192 },
          "coding-latest": { label: "Alias override" },
          manual: { contextWindow: 10000, maxOutputTokens: 1000 },
        },
      );
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
      false,
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
    const provider = new MistralProvider("work", "api", "key", async () => response, false, {
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

it("preserves imported IDs exactly and leaves selected context at its original cache position", () => {
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
  const wire = buildMistralRequest(base);
  expect(wire.instructions).toBe("Stable system");
  expect(wire.inputs.at(-1)).toEqual({ type: "message.input", role: "user", content: "changes" });
  const id = "other-provider-id";

  expect(wire.inputs[1]).toMatchObject({ type: "function.call", tool_call_id: id });
  expect(wire.inputs[2]).toMatchObject({ type: "function.result", tool_call_id: id });
  expect(buildMistralRequest(base)).toEqual(wire);
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
      [],
      200,
      false,
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
      [],
      200,
      false,
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
    const { provider } = await fixture(mode, [], 200, false, {
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
    const { provider, gateway } = await fixture(
      mode,
      [message("manual reply"), done()],
      200,
      false,
      {
        manual: { temperature: 0.4, reasoning: { supported: true, effortLevels: ["off", "high"] } },
        coding: { temperature: 0.2, reasoning: { supported: true, effortLevels: ["low"] } },
        "coding-latest": { reasoning: { supported: false } },
      },
    );
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
      expect(gateway.requests.at(-1)?.body.completion_args).toMatchObject({
        temperature,
        reasoning_effort,
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
