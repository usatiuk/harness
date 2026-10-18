import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationId,
  Item,
  ModelRequest,
  ModelStreamEvent,
  ProviderPayloadDraft,
} from "@harness/protocol";
import { LiteLLMProvider } from "./provider.ts";
import { liteLLMConfigSchema } from "./config.ts";
import { enrichModels, parseIndex, fetchCatalogJson } from "./discovery.ts";
import { httpGateway, json, sse } from "./http-fixture.ts";

const gateways: Awaited<ReturnType<typeof httpGateway>>[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});
const signal = new AbortController().signal;
async function collect(provider: LiteLLMProvider, request: ModelRequest, abort = signal) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(request, abort, {
    conversationId: "conversation" as ConversationId,
  }))
    events.push(event);
  return events;
}
const request = (provider = "work", model = "coding"): ModelRequest => ({
  instructions: [{ type: "text", text: "System instructions" }],
  items: [],
  prompt: "Call echo",
  tools: [
    {
      kind: "function",
      name: "echo",
      description: "Echo",
      parameters: { type: "object", properties: { x: { type: "number" } } },
    },
  ],
  modelConfig: { provider, model },
});
function item(fields: Record<string, unknown>, seq: number): Item {
  return {
    id: `item-${seq}`,
    conversationId: "conversation",
    turnId: "turn",
    seq,
    parent: null,
    createdAt: seq,
    ...fields,
  } as Item;
}
function continuation(first: ModelStreamEvent[], base: ModelRequest): ModelRequest {
  const items: ModelRequest["items"] = [];
  for (const event of first) {
    if (event.type === "reasoning") {
      const reasoning = item({ type: "reasoning", content: event.content }, items.length);
      items.push({
        item: reasoning,
        ...(event.payload ? { payload: { ...event.payload, itemId: reasoning.id } } : {}),
      });
    }
    if (event.type === "tool_call")
      items.push({
        item: item(
          { type: "tool_call", callId: event.callId, name: event.name, args: event.args },
          items.length,
        ),
      });
  }
  items.push({
    item: item(
      {
        type: "tool_result",
        callId: "call-1",
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

describe("LiteLLM discovery", () => {
  it("prefers exact effort lists and conservatively resolves legacy flags per deployment", () => {
    const infos = [
      { reasoning_effort_levels: ["low", "max"], supports_none_reasoning_effort: true },
      { reasoning_effort_levels: [], supports_low_reasoning_effort: true },
      { supports_reasoning: true },
      {
        supports_none_reasoning_effort: true,
        supports_minimal_reasoning_effort: false,
        supports_low_reasoning_effort: false,
        supports_xhigh_reasoning_effort: true,
      },
      { supports_reasoning: false, reasoning_effort_levels: ["high"] },
    ];
    const result = enrichModels(
      infos.map((_, i) => String(i)),
      { data: infos.map((model_info, i) => ({ model_name: String(i), model_info })) },
    );
    expect(result.models.map((model) => model.profile.reasoning?.effortLevels)).toEqual([
      ["low", "max"],
      [],
      undefined,
      ["high", "medium", "none", "xhigh"],
      [],
    ]);
    const mixed = enrichModels(["mixed"], {
      data: [
        { model_name: "mixed", model_info: { supports_low_reasoning_effort: true } },
        { model_name: "mixed", model_info: { supports_low_reasoning_effort: false } },
      ],
    });
    expect(mixed.models[0]?.profile.reasoning?.effortLevels).toBeUndefined();
    expect(mixed.diagnostics).toContain(
      "Model 'mixed' has conflicting reasoning effort levels metadata",
    );
  });
  it("rejects invalid configured reasoning defaults and drops only invalid remote defaults", () => {
    const reasoning = { supported: true, effortLevels: ["low"], defaultEffort: "high" };
    expect(() =>
      liteLLMConfigSchema.parse({
        baseUrl: "http://fixture.test",
        models: { coding: { reasoning } },
      }),
    ).toThrow("reasoning.defaultEffort");
    const result = enrichModels(["coding"], {
      data: [
        {
          model_name: "coding",
          model_info: {
            harness: { version: 1, contextWindow: 10000, reasoning },
          },
        },
      ],
    });
    expect(result.models[0]?.profile).toEqual({
      contextWindow: 10000,
      reasoning: { supported: true, effortLevels: ["low"] },
    });
    expect(result.diagnostics).toEqual([
      "Model 'coding' has an unadvertised default reasoning effort",
    ]);
  });
  it("collects explicit input/output and reasoning claims without inventing context or controls", () => {
    const metadata = {
      max_tokens: 999999,
      max_input_tokens: 200000,
      max_output_tokens: 32000,
      supports_reasoning: true,
      supports_adaptive_thinking: false,
      supports_legacy_thinking: null,
      thinking_always_on: true,
      reasoning_effort_levels: ["low", "high"],
      default_reasoning_effort: "low",
    };
    const result = enrichModels(["coding", "conflicting", "sparse", "invalid"], {
      data: [
        { model_name: "coding", model_info: metadata },
        {
          model_name: "coding",
          model_info: { ...metadata, reasoning_effort_levels: ["high", "low", "low"] },
        },
        {
          model_name: "conflicting",
          model_info: { supports_reasoning: true, max_input_tokens: 8000 },
        },
        {
          model_name: "conflicting",
          model_info: { supports_reasoning: false, max_input_tokens: 32000 },
        },
        { model_name: "sparse", model_info: metadata },
        { model_name: "sparse", model_info: null },
        {
          model_name: "invalid",
          model_info: { supports_reasoning: "true", max_output_tokens: -1 },
        },
      ],
    });
    expect(result.models[0]?.profile).toEqual({
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      reasoning: {
        supported: true,
        adaptiveThinking: false,
        alwaysOn: true,
        effortLevels: ["high", "low"],
        defaultEffort: "low",
      },
    });
    expect(result.models.slice(1).map((model) => model.profile)).toEqual([{}, {}, {}]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        "Model 'conflicting' has conflicting input capacity metadata",
        "Model 'conflicting' has conflicting supports_reasoning metadata",
        "Model 'invalid' has invalid output capacity metadata",
        "Model 'invalid' has invalid supports_reasoning metadata",
      ]),
    );
  });

  it("offers advertised reasoning presets and sends the selected effort", async () => {
    const gateway = await httpGateway((req, res) => {
      if (req.path.endsWith("/v1/models")) return json(res, { data: [{ id: "coding" }] });
      if (req.path.endsWith("/model/info"))
        return json(res, {
          data: [
            {
              model_name: "coding",
              model_info: { supports_reasoning: true, reasoning_effort_levels: ["low", "high"] },
            },
          ],
        });
      return sse(res, [{ type: "response.completed", response: {} }]);
    });
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({
        baseUrl: gateway.url,
        defaultTransport: "openai-responses",
      }),
      "key",
    );
    await provider.refreshModels(signal);
    expect(provider.listModels()[0]).toMatchObject({
      reasoning: { supported: true },
      presets: [{ value: "low" }, { value: "high" }],
    });
    await collect(provider, request());
    expect(gateway.requests.at(-1)?.body.include).toBeUndefined();
    expect(gateway.requests.at(-1)?.body.reasoning).toBeUndefined();
    await collect(provider, {
      ...request(),
      modelConfig: { provider: "work", model: "coding", preset: "high" },
    });
    expect(gateway.requests.at(-1)?.body.reasoning).toEqual({ effort: "high" });
    const overridden = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({
        baseUrl: gateway.url,
        defaultTransport: "openai-responses",
        models: { coding: { presets: {} } },
      }),
      "key",
    );
    await overridden.refreshModels(signal);
    expect(overridden.listModels()[0]?.presets).toEqual([]);
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "uses the advertised default and transport-compatible generated presets over %s",
    async (transport) => {
      const sessionHeaders: unknown[] = [];
      const gateway = await httpGateway((req, res, raw) => {
        if (req.body.model) sessionHeaders.push(raw.headers["x-litellm-session-id"]);
        if (req.path.endsWith("/v1/models")) return json(res, { data: [{ id: "coding" }] });
        if (req.path.endsWith("/model/info"))
          return json(res, {
            data: [
              {
                model_name: "coding",
                model_info: {
                  reasoning_effort_levels: ["none", "low", "high"],
                  default_reasoning_effort: "low",
                },
              },
            ],
          });
        if (transport === "openai-completions")
          return sse(res, [
            { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
          ]);
        if (transport === "anthropic-messages")
          return sse(res, [
            {
              type: "message_start",
              message: {
                id: "msg",
                role: "assistant",
                model: "coding",
                content: [],
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 },
            },
            { type: "message_stop" },
          ]);
        return sse(res, [{ type: "response.completed", response: {} }]);
      });
      gateways.push(gateway);
      const provider = new LiteLLMProvider(
        "work",
        liteLLMConfigSchema.parse({ baseUrl: gateway.url, defaultTransport: transport }),
        "key",
      );
      await provider.refreshModels(signal);
      expect(provider.listModels()[0]?.defaultPreset).toBe("low");
      await collect(provider, request());
      const body = gateway.requests.at(-1)!.body;
      expect(sessionHeaders).toEqual(["conversation"]);
      expect(body.prompt_cache_key).toBe(
        transport === "anthropic-messages" ? undefined : "conversation",
      );
      expect(
        transport === "openai-completions"
          ? body.reasoning_effort
          : transport === "openai-responses"
            ? (body.reasoning as { effort: string }).effort
            : (body.output_config as { effort: string }).effort,
      ).toBe("low");
      if (transport !== "anthropic-messages") {
        await collect(provider, {
          ...request(),
          modelConfig: { provider: "work", model: "coding", preset: "none" },
        });
        const off = gateway.requests.at(-1)!.body;
        expect(
          transport === "openai-completions"
            ? off.reasoning_effort
            : (off.reasoning as { effort: string }).effort,
        ).toBe("none");
      } else
        expect(provider.listModels()[0]?.presets).toEqual([{ value: "low" }, { value: "high" }]);
    },
  );

  it("propagates deterministic fetch defects even when cancellation races them", async () => {
    const controller = new AbortController();
    const defect = new TypeError("Fixture deterministic defect");
    const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      throw defect;
    });
    try {
      await expect(fetchCatalogJson("http://fixture.test", "key", controller.signal)).rejects.toBe(
        defect,
      );
    } finally {
      mocked.mockRestore();
    }
  });

  it("classifies actual connection failure and prevents discovery redirects", async () => {
    const offline = await httpGateway((_req, res) => json(res, {}));
    await offline.close();
    await expect(fetchCatalogJson(offline.url, "key", signal)).rejects.toMatchObject({
      code: "network",
    });
    const gateway = await httpGateway((_req, res) => {
      res.writeHead(302, { location: "https://should-not-follow.test" });
      res.end();
    });
    gateways.push(gateway);
    await expect(fetchCatalogJson(gateway.url, "key", signal)).rejects.toMatchObject({
      code: "http",
      status: 302,
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it("classifies an HTTPS connection to a plain HTTP listener as an external transport failure", async () => {
    const gateway = await httpGateway((_req, res) => json(res, {}));
    gateways.push(gateway);
    await expect(
      fetchCatalogJson(gateway.url.replace("http:", "https:"), "key", signal),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("keeps independent route/capacity metadata when conflicting presets invalidate the default", () => {
    const result = enrichModels(["coding"], {
      data: ["low", "high"].map((reasoningEffort) => ({
        model_name: "coding",
        model_info: {
          harness: {
            version: 1,
            transport: "openai-responses",
            contextWindow: 10000,
            presets: { precise: { reasoningEffort } },
            defaultPreset: "precise",
          },
        },
      })),
    });
    expect(result.models[0]?.profile).toEqual({
      transport: "openai-responses",
      contextWindow: 10000,
    });
    expect(result.diagnostics).toContain("Model 'coding' has no agreed default preset");
  });
  it("preserves nullable unknown capabilities and omits conflicting hard capacities", () => {
    const result = enrichModels(["unknown", "conflicting", "uniform"], {
      data: [
        {
          model_name: "unknown",
          model_info: { mode: null, supports_function_calling: null, supports_tool_calling: null },
        },
        { model_name: "unknown", model_info: null },
        { model_name: "conflicting", model_info: { max_output_tokens: 8000 } },
        { model_name: "conflicting", model_info: { max_output_tokens: 32000 } },
        { model_name: "uniform", model_info: { max_output_tokens: 32000 } },
        { model_name: "uniform", model_info: { max_output_tokens: 32000 } },
      ],
    });
    expect(result.models).toEqual([
      { id: "unknown", supported: true, profile: {} },
      { id: "conflicting", supported: true, profile: {} },
      { id: "uniform", supported: true, profile: { maxOutputTokens: 32000 } },
    ]);
    expect(result.diagnostics).toEqual([
      "Model 'conflicting' has conflicting output capacity metadata",
    ]);
  });

  it("enriches configured hidden aliases, replaces presets, and requires a qualified unsupported override", async () => {
    const gateway = await httpGateway((req, res) =>
      req.path.endsWith("/v1/models")
        ? json(res, { data: [{ id: "constructor" }, { id: "excluded" }, { id: "qualified" }] })
        : json(res, {
            data: [
              ...["constructor", "excluded", "qualified"].map((model_name) => ({
                model_name,
                model_info: { mode: "embedding" },
              })),
              {
                model_name: "hidden",
                model_info: {
                  harness: {
                    version: 1,
                    transport: "openai-responses",
                    contextWindow: 12345,
                    presets: { remote: { reasoningEffort: "high" } },
                    defaultPreset: "remote",
                  },
                },
              },
            ],
          }),
    );
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({
        baseUrl: gateway.url,
        models: {
          hidden: { presets: {} },
          excluded: { label: "A label is not qualification" },
          qualified: { codingCompatible: true },
        },
      }),
      "key",
    );
    await provider.refreshModels(signal);
    expect(provider.listModels().map((model) => model.model)).toEqual(["qualified", "hidden"]);
    expect(provider.listModels()[1]).toMatchObject({ contextWindow: 12345, presets: [] });
    expect(provider.listModels()[1]?.defaultPreset).toBeUndefined();
    expect(provider.capabilities("hidden").preferredEditTool).toBe("replace");
  });

  it("bounds index model count and response bytes", async () => {
    expect(() =>
      parseIndex({ data: Array.from({ length: 5001 }, (_, index) => ({ id: `model-${index}` })) }),
    ).toThrow("invalid data array");
    const gateway = await httpGateway((_req, res) =>
      json(res, { data: [], padding: "x".repeat(2 * 1024 * 1024) }),
    );
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({ baseUrl: gateway.url, models: { manual: {} } }),
      "key",
    );
    await expect(provider.refreshModels(signal)).rejects.toThrow("exceeds 2 MiB");
    expect(provider.listModels().map((model) => model.model)).toEqual(["manual"]);
  });
  it("isolates keys/catalogs, enriches exact public aliases, and applies hidden local entries", async () => {
    const gateway = await httpGateway((req, res) => {
      if (req.path.endsWith("/v1/models"))
        return json(res, {
          data: [
            { id: req.key === "work-key" ? "coding" : "personal-alias", extra: "allowed" },
            { id: req.key === "work-key" ? "coding" : "personal-alias" },
          ],
        });
      return json(res, {
        data: [
          {
            model_name: "coding",
            litellm_params: { model: "vendor/private", api_key: "DO NOT COPY" },
            model_info: {
              max_input_tokens: 100,
              max_output_tokens: 50,
              input_cost_per_token: 99,
              harness: {
                version: 1,
                transport: "openai-responses",
                preferredEditTool: "patch",
                contextWindow: 1000,
              },
            },
          },
          {
            model_name: "not-advertised",
            model_info: { harness: { version: 1, contextWindow: 123 } },
          },
        ],
      });
    });
    gateways.push(gateway);
    const config = liteLLMConfigSchema.parse({
      baseUrl: `${gateway.url}/team`,
      models: { hidden: { transport: "anthropic-messages", requestMaxOutputTokens: 300 } },
    });
    const work = new LiteLLMProvider("work", config, "work-key");
    const personal = new LiteLLMProvider(
      "personal",
      liteLLMConfigSchema.parse({ baseUrl: `${gateway.url}/team` }),
      "personal-key",
    );
    await Promise.all([work.refreshModels(signal), personal.refreshModels(signal)]);
    expect(work.listModels().map((model) => model.model)).toEqual(["coding", "hidden"]);
    expect(personal.listModels().map((model) => model.model)).toEqual(["personal-alias"]);
    expect(work.listModels()[0]).toMatchObject({
      provider: "work",
      model: "coding",
      contextWindow: 1000,
      maxOutputTokens: 50,
    });
    expect(work.listModels()[0]?.pricing).toBeUndefined();
    expect(work.capabilities("coding").preferredEditTool).toBe("patch");
    const copy = work.listModels();
    copy[0]!.model = "mutated";
    expect(work.listModels()[0]?.model).toBe("coding");
    expect(
      gateway.requests.every(
        (req) => req.path.startsWith("/team/") && ["work-key", "personal-key"].includes(req.key),
      ),
    ).toBe(true);
  });

  it("replaces successful rosters, retains failed snapshots, and drops stale enrichment", async () => {
    let mode = "rich";
    const gateway = await httpGateway((req, res) => {
      if (req.path.endsWith("/v1/models"))
        return json(
          res,
          mode === "bad-index"
            ? { invalid: true }
            : { data: mode === "empty" ? [] : [{ id: "coding" }] },
        );
      if (mode !== "rich") return json(res, { error: "not allowed" }, 403);
      return json(res, {
        data: {
          model_name: "coding",
          model_info: {
            harness: {
              version: 1,
              transport: "openai-responses",
              presets: { precise: { reasoningEffort: "high" } },
            },
          },
        },
      });
    });
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({ baseUrl: gateway.url }),
      "key",
    );
    expect((await provider.refreshModels(signal)).status).toBe("ready");
    expect(provider.listModels()[0]?.presets).toEqual([{ value: "precise" }]);
    mode = "bad-index";
    await expect(provider.refreshModels(signal)).rejects.toThrow("invalid data array");
    expect(provider.listModels()[0]?.presets).toEqual([{ value: "precise" }]);
    mode = "denied";
    expect((await provider.refreshModels(signal)).status).toBe("degraded");
    expect(provider.listModels()[0]?.presets).toEqual([]);
    const payload: ProviderPayloadDraft = {
      provider: "work",
      model: "coding",
      type: "reasoning",
      version: 1,
      payload: { id: "r", encryptedContent: "CIPHER" },
    };
    const reasoning = item({ type: "reasoning", content: [] }, 0);
    await expect(
      collect(provider, {
        ...request(),
        items: [{ item: reasoning, payload: { ...payload, itemId: reasoning.id } }],
      }),
    ).rejects.toThrow("requires its original transport");
    expect(gateway.requests.filter((req) => req.body.model)).toHaveLength(0);
    mode = "empty";
    await provider.refreshModels(signal);
    expect(provider.listModels()).toEqual([]);
  });

  it("excludes mixed/unsupported deployments, omits conflicting claims, and rejects malformed indexes", () => {
    expect(parseIndex({ data: [{ id: "alias" }, { id: "alias" }] })).toEqual(["alias"]);
    expect(() => parseIndex({ data: [{ id: "" }] })).toThrow("invalid data array");
    const enriched = enrichModels(["mixed", "tools", "conflict", "sparse"], {
      data: [
        { model_name: "mixed", model_info: { mode: "chat" } },
        { model_name: "mixed", model_info: { mode: "embedding" } },
        { model_name: "tools", model_info: { supports_function_calling: false } },
        {
          model_name: "conflict",
          model_info: {
            harness: { version: 1, transport: "openai-responses", contextWindow: 1000 },
          },
        },
        {
          model_name: "conflict",
          model_info: {
            harness: { version: 1, transport: "anthropic-messages", contextWindow: 1000 },
          },
        },
      ],
    });
    expect(enriched.models.map((model) => model.supported)).toEqual([false, false, true, true]);
    expect(enriched.models[2]?.profile).toEqual({ contextWindow: 1000 });
    expect(enriched.diagnostics).toHaveLength(3);
    expect(() =>
      liteLLMConfigSchema.parse({ baseUrl: "https://user:password@host", models: {} }),
    ).toThrow();
    expect(() =>
      liteLLMConfigSchema.parse({
        baseUrl: "https://host",
        models: { coding: { customToolInput: { supported: true, grammars: [] } } },
      }),
    ).toThrow("custom tool input requires");
  });
});

describe("LiteLLM SDK transport fidelity", () => {
  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "keeps hard capacity separate from request defaults over %s",
    async (transport) => {
      const gateway = await httpGateway((_req, res) =>
        transport === "anthropic-messages"
          ? sse(
              res,
              [
                {
                  type: "message_start",
                  message: { usage: { input_tokens: 1, output_tokens: 0 } },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 1 },
                },
                { type: "message_stop" },
              ],
              true,
            )
          : transport === "openai-responses"
            ? sse(res, [{ type: "response.completed", response: {} }])
            : sse(res, [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
      );
      gateways.push(gateway);
      const provider = new LiteLLMProvider(
        "work",
        liteLLMConfigSchema.parse({
          baseUrl: gateway.url,
          models: { coding: { transport, maxOutputTokens: 32000 } },
        }),
        "key",
      );
      await collect(provider, request());
      const body = gateway.requests[0]!.body;
      expect(body[transport === "openai-responses" ? "max_output_tokens" : "max_tokens"]).toBe(
        transport === "anthropic-messages" ? 8192 : undefined,
      );
      expect(body.include).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      await collect(provider, { ...request(), maxOutputTokens: 64000 });
      expect(
        gateway.requests[1]!.body[
          transport === "openai-responses" ? "max_output_tokens" : "max_tokens"
        ],
      ).toBe(32000);
    },
  );

  it("rejects impossible default thinking budgets and refuses opaque thinking with disabled controls", async () => {
    expect(() =>
      liteLLMConfigSchema.parse({
        baseUrl: "https://gateway.test",
        models: {
          coding: {
            transport: "anthropic-messages",
            maxOutputTokens: 32000,
            thinking: { type: "enabled", budget_tokens: 10000 },
          },
        },
      }),
    ).toThrow("thinking budget");
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({
        baseUrl: "https://gateway.test",
        models: { coding: { transport: "anthropic-messages" } },
      }),
      "key",
    );
    const reasoning = item({ type: "reasoning", content: [] }, 0);
    await expect(
      collect(provider, {
        ...request(),
        items: [
          {
            item: reasoning,
            payload: {
              itemId: reasoning.id,
              provider: "work",
              model: "coding",
              type: "thinking",
              version: 1,
              payload: {},
            },
          },
        ],
      }),
    ).rejects.toThrow("Saved thinking requires");
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "round-trips aliases, tools, reasoning and usage over %s",
    async (transport) => {
      let calls = 0;
      const gateway = await httpGateway((req, res) => {
        if (req.path.endsWith("/v1/models")) return json(res, { data: [{ id: "coding" }] });
        if (req.path.endsWith("/model/info")) return json(res, { data: [] });
        calls++;
        if (transport === "openai-completions")
          return sse(
            res,
            calls === 1
              ? [
                  {
                    choices: [
                      {
                        delta: {
                          reasoning_content: "thought",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-1",
                              function: { name: "echo", arguments: '{"x":1}' },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  },
                  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
                ]
              : [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }],
          );
        if (transport === "openai-responses")
          return sse(
            res,
            calls === 1
              ? [
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "reasoning",
                      id: "reason-1",
                      summary: [{ type: "summary_text", text: "thought" }],
                      encrypted_content: "CIPHER",
                    },
                  },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      call_id: "call-1",
                      name: "echo",
                      arguments: '{"x":1}',
                    },
                  },
                  {
                    type: "response.completed",
                    response: { usage: { input_tokens: 10, output_tokens: 5 } },
                  },
                ]
              : [
                  { type: "response.output_text.delta", delta: "done" },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "done" }],
                    },
                  },
                  { type: "response.completed", response: {} },
                ],
          );
        return sse(
          res,
          [
            { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
            ...(calls === 1
              ? [
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "", signature: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "thinking_delta", thinking: "thought" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "signature_delta", signature: "SIGNATURE" },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "tool_use", id: "call-1", name: "echo", input: {} },
                  },
                  {
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "input_json_delta", partial_json: '{"x":1}' },
                  },
                  { type: "content_block_stop", index: 1 },
                ]
              : [
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "done" },
                  },
                  { type: "content_block_stop", index: 0 },
                ]),
            {
              type: "message_delta",
              delta: { stop_reason: calls === 1 ? "tool_use" : "end_turn" },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          ],
          true,
        );
      });
      gateways.push(gateway);
      const provider = new LiteLLMProvider(
        "work",
        liteLLMConfigSchema.parse({
          baseUrl: `${gateway.url}/prefix`,
          models: {
            coding: {
              transport,
              ...(transport === "anthropic-messages" ? { thinking: { type: "adaptive" } } : {}),
              presets: { precise: { reasoningEffort: "high", requestMaxOutputTokens: 1234 } },
            },
          },
        }),
        "virtual-key",
      );
      await provider.refreshModels(signal);
      const base = {
        ...request(),
        modelConfig: { provider: "work", model: "coding", preset: "precise" },
      };
      const first = await collect(provider, base);
      expect(first.find((event) => event.type === "tool_call")).toMatchObject({
        callId: "call-1",
        name: "echo",
        args: { x: 1 },
      });
      expect(first.find((event) => event.type === "completed")).toMatchObject({
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      expect(await collect(provider, continuation(first, base))).toContainEqual({
        type: "text_delta",
        text: "done",
      });
      const sent = gateway.requests.filter((req) => req.body.model);
      expect(sent).toHaveLength(2);
      expect(
        sent.every(
          (req) =>
            req.key === "virtual-key" &&
            req.body.model === "coding" &&
            req.path.startsWith("/prefix/v1/"),
        ),
      ).toBe(true);
      expect(
        sent[0]!.body[transport === "openai-responses" ? "max_output_tokens" : "max_tokens"],
      ).toBe(1234);
      if (transport === "openai-responses") {
        expect(sent[1]!.body.input).toEqual(
          expect.arrayContaining([
            {
              type: "reasoning",
              id: "reason-1",
              encrypted_content: "CIPHER",
              summary: [{ type: "summary_text", text: "thought" }],
            },
            { type: "function_call_output", call_id: "call-1", output: "echoed" },
          ]),
        );
        expect(sent[0]!.body.store).toBe(false);
        expect(sent[0]!.body.reasoning).toEqual({ effort: "high" });
        expect(first.find((event) => event.type === "reasoning")).toMatchObject({
          payload: { provider: "work", model: "coding" },
        });
      } else {
        const serialized = JSON.stringify(sent[1]!.body.messages);
        expect(serialized).toContain("echoed");
        expect(serialized).toContain(
          transport === "anthropic-messages" ? "SIGNATURE" : "reasoning_content",
        );
        expect(serialized).toContain("thought");
      }
    },
  );

  it("cancels a held index request and retains configured entries", async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gateway = await httpGateway(() => {
      entered();
    });
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "work",
      liteLLMConfigSchema.parse({ baseUrl: gateway.url, models: { hidden: {} } }),
      "key",
    );
    const controller = new AbortController();
    const refreshing = provider.refreshModels(controller.signal);
    const rejected = expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    await waiting;
    controller.abort();
    await rejected;
    expect(provider.listModels().map((model) => model.model)).toEqual(["hidden"]);
  });
});

it("publishes agreed vision claims, preserving false and unknown metadata", async () => {
  const ids = ["vision", "text", "unknown", "partial", "conflicting", "invalid"];
  const rows = [
    ...[true, true].map((supports_vision) => ({
      model_name: "vision",
      model_info: { supports_vision },
    })),
    { model_name: "text", model_info: { supports_vision: false } },
    { model_name: "unknown", model_info: { supports_vision: null } },
    { model_name: "partial", model_info: { supports_vision: true } },
    { model_name: "partial", model_info: {} },
    { model_name: "conflicting", model_info: { supports_vision: true } },
    { model_name: "conflicting", model_info: { supports_vision: false } },
    { model_name: "invalid", model_info: { supports_vision: "yes" } },
  ];
  const gateway = await httpGateway((req, res) =>
    json(
      res,
      req.path.endsWith("/v1/models") ? { data: ids.map((id) => ({ id })) } : { data: rows },
    ),
  );
  gateways.push(gateway);
  const provider = new LiteLLMProvider(
    "work",
    liteLLMConfigSchema.parse({ baseUrl: gateway.url }),
    "key",
  );
  const refreshed = await provider.refreshModels(signal);
  expect(refreshed.diagnostics).toContain(
    "Model 'conflicting' has conflicting image support metadata",
  );
  expect(refreshed.diagnostics).toContain("Model 'invalid' has invalid image support metadata");
  expect(
    provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
  ).toEqual([
    { model: "vision", supportsImages: true },
    { model: "text", supportsImages: false },
    ...["unknown", "partial", "conflicting", "invalid"].map((model) => ({
      model,
      supportsImages: undefined,
    })),
  ]);
});

it("lets configured image support override remote metadata while preserving unknown", async () => {
  const rows = [
    { model_name: "remote-vision", model_info: { supports_vision: true } },
    { model_name: "remote-text", model_info: { supports_vision: false } },
  ];
  const gateway = await httpGateway((req, res) =>
    json(
      res,
      req.path.endsWith("/v1/models")
        ? { data: rows.map(({ model_name }) => ({ id: model_name })) }
        : { data: rows },
    ),
  );
  gateways.push(gateway);
  const provider = new LiteLLMProvider(
    "work",
    liteLLMConfigSchema.parse({
      baseUrl: gateway.url,
      models: {
        "remote-vision": { supportsImages: false },
        "remote-text": { supportsImages: true },
        configured: { supportsImages: true },
        unknown: {},
      },
    }),
    "key",
  );
  await provider.refreshModels(signal);
  expect(
    provider.listModels().map(({ model, supportsImages }) => ({ model, supportsImages })),
  ).toEqual([
    { model: "remote-vision", supportsImages: false },
    { model: "remote-text", supportsImages: true },
    { model: "configured", supportsImages: true },
    { model: "unknown", supportsImages: undefined },
  ]);
});

it("retains image claims when unrelated remote generation settings are incompatible", async () => {
  const gateway = await httpGateway((req, res) =>
    json(
      res,
      req.path.endsWith("/v1/models")
        ? { data: [{ id: "text" }] }
        : {
            data: [
              {
                model_name: "text",
                model_info: {
                  supports_vision: false,
                  harness: { version: 1, thinking: { type: "adaptive" } },
                },
              },
            ],
          },
    ),
  );
  gateways.push(gateway);
  const provider = new LiteLLMProvider(
    "work",
    liteLLMConfigSchema.parse({ baseUrl: gateway.url }),
    "key",
  );
  const result = await provider.refreshModels(signal);
  expect(result.diagnostics).toContain(
    "Model 'text' has incompatible metadata; using configured defaults",
  );
  expect(provider.listModels()[0]?.supportsImages).toBe(false);
});

describe("tool-input metadata", () => {
  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "adds a manual JSON patch model over %s",
    (transport) => {
      const config = liteLLMConfigSchema.parse({
        baseUrl: "http://localhost:8787",
        models: { manual: { transport, preferredEditTool: "patch", maxInputTokens: 12345 } },
      });
      const provider = new LiteLLMProvider("gateway", config, "test-key");
      expect(provider.capabilities("manual")).toMatchObject({
        preferredEditTool: "patch",
        customToolInput: { supported: false, grammars: [] },
      });
      expect(provider.listModels()).toMatchObject([{ model: "manual", maxInputTokens: 12345 }]);
    },
  );

  it("requires custom-input support before enabling grammars", () => {
    expect(() =>
      liteLLMConfigSchema.parse({
        baseUrl: "http://localhost:8787",
        models: { manual: { customToolInput: { supported: false, grammars: ["lark"] } } },
      }),
    ).toThrow("grammar support requires");
  });

  it("discovers agreed custom metadata and lets local configuration override it", async () => {
    const gateway = await httpGateway((req, res) =>
      json(
        res,
        req.path === "/v1/models"
          ? {
              data: [{ id: "coding" }],
            }
          : {
              data: [
                {
                  model_name: "coding",
                  model_info: {
                    harness: {
                      version: 1,
                      transport: "openai-responses",
                      preferredEditTool: "patch",
                      customToolInput: { supported: true, grammars: ["lark"] },
                    },
                  },
                },
              ],
            },
      ),
    );
    gateways.push(gateway);
    const provider = new LiteLLMProvider(
      "gateway",
      liteLLMConfigSchema.parse({
        baseUrl: gateway.url,
        models: { coding: { preferredEditTool: "replace" } },
      }),
      "test-key",
    );
    await provider.refreshModels(signal);
    expect(provider.capabilities("coding")).toMatchObject({
      preferredEditTool: "replace",
      customToolInput: { supported: true, grammars: ["lark"] },
    });
  });
});
