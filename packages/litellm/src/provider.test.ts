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

  it("keeps advertised reasoning informational without inventing request controls", async () => {
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
    expect(provider.listModels()[0]).toMatchObject({ reasoning: { supported: true }, presets: [] });
    await collect(provider, request());
    expect(gateway.requests.at(-1)?.body.include).toBeUndefined();
    expect(gateway.requests.at(-1)?.body.reasoning).toBeUndefined();
  });

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
    expect(provider.capabilities("hidden").fileTools).toBe("string_replace");
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
                fileTools: "apply_patch",
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
    expect(work.capabilities("coding").fileTools).toBe("apply_patch");
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
        models: { coding: { fileTools: "apply_patch" } },
      }),
    ).toThrow("apply_patch requires");
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
