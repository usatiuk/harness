import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { ContextWindowExceededError, ModelDiscoveryError } from "@harness/protocol";
import { httpGateway, json, sse } from "../../litellm/src/http-fixture.ts";
import { MistralProvider } from "./provider.ts";
import { fetchCatalog, parseCatalog } from "./catalog.ts";
import { buildMistralRequest, nativeCallId } from "./request.ts";

const gateways: Awaited<ReturnType<typeof httpGateway>>[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
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
function mistralChunk(delta: unknown, finish: string | null = null, usage?: unknown) {
  return { choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
}
const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 80 },
};
async function collect(provider: MistralProvider, req = request(), abort = signal) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(req, abort, context)) events.push(event);
  return events;
}
function item(fields: Record<string, unknown>, seq: number): Item {
  return {
    id: `item-${seq}`,
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
  let text = "";
  const append = (
    fields: Record<string, unknown>,
    payload?: Extract<ModelStreamEvent, { type: "reasoning" | "tool_call" }>["payload"],
  ) => {
    const next = item(fields, items.length);
    items.push({ item: next, ...(payload ? { payload: { ...payload, itemId: next.id } } : {}) });
  };
  const flush = () => {
    if (text) append({ type: "message", role: "assistant", content: [{ type: "text", text }] });
    text = "";
  };
  for (const event of first) {
    if (event.type === "text_delta") text += event.text;
    if (event.type === "reasoning") {
      flush();
      append({ type: "reasoning", content: event.content }, event.payload);
    }
    if (event.type === "tool_call") {
      flush();
      append(
        { type: "tool_call", callId: event.callId, name: event.name, args: event.args },
        event.payload,
      );
    }
  }
  flush();
  for (const event of first)
    if (event.type === "tool_call")
      append({
        type: "tool_result",
        callId: event.callId,
        status: "ok",
        content: [{ type: "text", text: "echoed" }],
      });
  const next = { ...base, items };
  delete next.prompt;
  return next;
}
async function fixture(mode: "api" | "vibe", events: unknown[], status = 200) {
  const headers: Record<string, unknown>[] = [];
  const gateway = await httpGateway((req, response, raw) => {
    headers.push(raw.headers);
    if (req.method === "GET") json(response, catalog(mode));
    else if (status !== 200)
      json(
        response,
        { error: { message: "context length exceeded", code: "context_length_exceeded" } },
        status,
      );
    else sse(response, events);
  });
  gateways.push(gateway);
  const provider = new MistralProvider("work", mode, "fixture-key", (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    expect(url.startsWith("https://api.mistral.ai/v1/")).toBe(true);
    return fetch(url.replace("https://api.mistral.ai", gateway.url), init);
  });
  await provider.refreshModels(signal);
  return { provider, gateway, headers };
}

describe("Mistral native delivery", () => {
  it("replays interleaved signed thinking, exact tool arguments and stable prompt prefixes over real HTTP/SSE", async () => {
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
      mistralChunk({ content: [{ ...firstBlock, signature: null, closed: false }] }),
      mistralChunk({
        content: [{ ...firstBlock, thinking: [] }, { type: "text", text: "Between" }, secondBlock],
      }),
      mistralChunk({
        tool_calls: [
          {
            index: 0,
            id: "abc123XYZ",
            type: "function",
            function: { name: "echo", arguments: rawArgs.slice(0, 5) },
          },
        ],
      }),
      mistralChunk(
        { tool_calls: [{ index: 0, function: { arguments: rawArgs.slice(5) } }] },
        "tool_calls",
        usage,
      ),
    ]);
    const base = request();
    base.maxOutputTokens = 1234;
    const first = await collect(provider, base);
    expect(first.at(-1)).toEqual({
      type: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80 },
    });
    const next = continuation(first, base);
    await collect(provider, next);
    const [a, b] = gateway.requests.filter((req) => req.method === "POST").map((req) => req.body);
    expect(a).toMatchObject({
      model: "coding",
      reasoning_effort: "high",
      temperature: 0.2,
      max_tokens: 1234,
      stream: true,
    });
    const aMessages = a!.messages as unknown[];
    const bMessages = b!.messages as unknown[];
    expect(bMessages.slice(0, aMessages.length)).toEqual(aMessages);
    expect(bMessages.slice(2)).toEqual([
      {
        role: "assistant",
        content: [firstBlock, { type: "text", text: "Between" }, secondBlock],
        tool_calls: [
          { id: "abc123XYZ", type: "function", function: { name: "echo", arguments: rawArgs } },
        ],
      },
      { role: "tool", name: "echo", tool_call_id: "abc123XYZ", content: "echoed" },
    ]);
    expect(b!.tools).toEqual(a!.tools);
    expect(
      headers
        .slice(1)
        .every(
          (value) => value["x-affinity"] === "child" && value["user-agent"] === "Harness/0.0.0",
        ),
    ).toBe(true);
    expect(gateway.requests.map((value) => value.key)).toEqual([
      "fixture-key",
      "fixture-key",
      "fixture-key",
    ]);
    expect(gateway.requests[0]?.path).toBe("/v1/model-catalog?surface=vibe-code");
  });

  it("uses the API catalog and preserves unknown accounting and unsupported controls", async () => {
    const { provider, gateway } = await fixture("api", [
      mistralChunk({ content: "done" }, "stop", { prompt_tokens: 10 }),
    ]);
    expect(provider.listModels()).toEqual([
      { provider: "work", model: "coding", label: "Coding", contextWindow: 262144 },
      { provider: "work", model: "coding-latest", label: "Coding", contextWindow: 262144 },
    ]);
    expect(provider.capabilities("coding")).toEqual({
      contentTypes: ["text"],
      toolCalling: true,
      fileTools: "string_replace",
    });
    expect((await collect(provider, request("api"))).at(-1)).toEqual({
      type: "completed",
      usage: null,
    });
    expect(gateway.requests[0]?.path).toBe("/v1/models");
    expect(gateway.requests[1]?.body.reasoning_effort).toBeUndefined();
    await expect(collect(provider)).rejects.toThrow("Unknown preset");
    await expect(
      collect(provider, { ...request("api"), modelConfig: { provider: "other", model: "coding" } }),
    ).rejects.toThrow("identity mismatch");
  });

  it.each([
    ["abc", "123", "XYZ"],
    ["abc", "abc123", "abc123XYZ"],
    ["abc123XYZ", "abc123XYZ", "abc123XYZ"],
  ])("accepts native fragmented and repeated tool-call IDs: %j", async (...ids) => {
    const { provider } = await fixture("api", [
      ...ids.map((id, index) =>
        mistralChunk({
          tool_calls: [
            {
              index: 0,
              id,
              function: index === 0 ? { name: "echo", arguments: '{"x":1}' } : {},
            },
          ],
        }),
      ),
      mistralChunk({}, "tool_calls", usage),
    ]);
    const events = await collect(provider, request("api"));
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      callId: "abc123XYZ",
      name: "echo",
      args: { x: 1 },
    });
    expect(events.at(-1)).toEqual({
      type: "completed",
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80 },
    });
  });

  it.each(["length", "content_filter", "unknown"])(
    "retains accounting on %s and never dispatches partial calls",
    async (finish) => {
      const { provider } = await fixture("api", [
        mistralChunk(
          {
            content: "partial",
            tool_calls: [{ id: "abc123XYZ", function: { name: "echo", arguments: '{"x":' } }],
          },
          finish,
          usage,
        ),
      ]);
      const events = await collect(provider, request("api"));
      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);
      const completed = events.at(-1);
      expect(completed).toMatchObject({
        type: "completed",
        usage: { inputTokens: 100 },
      });
      expect(completed?.type === "completed" && completed.error).toEqual(expect.any(String));
    },
  );
  it("rejects malformed calls before tools run and malformed accounting without fabricating completion", async () => {
    const { provider } = await fixture("api", [
      mistralChunk(
        { tool_calls: [{ id: "abc123XYZ", function: { name: "echo", arguments: "{bad" } }] },
        "tool_calls",
        usage,
      ),
    ]);
    const completed = (await collect(provider, request("api"))).at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      usage: { inputTokens: 100 },
    });
    expect(completed?.type === "completed" && completed.error).toContain("malformed");
    const invalid = await fixture("api", [
      mistralChunk({}, "stop", {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 6 },
      }),
    ]);
    await expect(collect(invalid.provider, request("api"))).rejects.toThrow(
      "invalid content or accounting",
    );
    const truncated = await fixture("api", [mistralChunk({ content: "partial" })]);
    await expect(collect(truncated.provider, request("api"))).rejects.toThrow(
      "without a finish reason",
    );
  });
  it("normalizes native context overflow before output", async () => {
    const { provider } = await fixture("api", [], 400);
    await expect(collect(provider, request("api"))).rejects.toBeInstanceOf(
      ContextWindowExceededError,
    );
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
      response.write(`data: ${JSON.stringify(mistralChunk({ content: "started" }))}\n\n`);
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
      const pending = expect(iterator.next()).rejects.toBe(reason);
      controller.abort(reason);
      await pending;
    } else await iterator.return?.();
    await drained;
  });
});

describe("Mistral catalog boundary", () => {
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
    expect(parsed.diagnostics).toHaveLength(2);
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

it("maps imported IDs deterministically and leaves selected context at its original cache position", () => {
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
  expect(wire.messages[0]).toEqual({ role: "system", content: "Stable system" });
  expect(wire.messages.at(-1)).toEqual({ role: "user", content: "changes" });
  const id = nativeCallId("other-provider-id");
  expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(wire.messages[2]).toMatchObject({ tool_calls: [{ id }] });
  expect(wire.messages[3]).toMatchObject({ tool_call_id: id });
  expect(buildMistralRequest(base)).toEqual(wire);
});
