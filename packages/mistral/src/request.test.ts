import { describe, expect, it } from "vitest";
import type { Item, ModelRequest, ModelStreamEvent, ProviderPayload } from "@harness/protocol";
import { buildMistralRequest } from "./request.ts";
import { mistralEvents } from "./stream.ts";
import { mistralAPIProviderType, mistralVibeProviderType } from "./index.ts";
const request = (): ModelRequest => ({
  instructions: [],
  items: [],
  modelConfig: { provider: "mistral", model: "test" },
  providerOptions: { webSearch: true },
});
const item = (value: object): Item =>
  ({
    id: "i",
    conversationId: "c",
    turnId: "t",
    parent: null,
    seq: 0,
    createdAt: 0,
    ...value,
  }) as Item;
const message = (content: unknown, content_index = 0) => ({
  type: "message.output.delta",
  id: "m",
  content_index,
  content,
});
const done = {
  type: "conversation.response.done",
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};
async function events(input: unknown[]) {
  const stream = (async function* () {
    yield* input;
  })();
  const output: ModelStreamEvent[] = [];
  for await (const event of mistralEvents(stream, "mistral", "test", new AbortController().signal))
    output.push(event);
  return output;
}
function history(output: ModelStreamEvent[]): ModelRequest["items"] {
  return output.flatMap((event) => {
    if (event.type !== "message" && event.type !== "reasoning" && event.type !== "tool_call")
      return [];
    const { payload, ...value } = event;
    return [
      {
        item: item({ ...value, ...(value.type === "message" ? { role: "assistant" } : {}) }),
        ...(payload ? { payload: { ...payload, itemId: "i" as ProviderPayload["itemId"] } } : {}),
      },
    ];
  });
}
describe("Mistral request boundary", () => {
  it("declares search for both connection types and forwards native tool choice independently", () => {
    for (const provider of [mistralAPIProviderType, mistralVibeProviderType])
      expect(provider.configSchema.parse({})).toMatchObject({ webSearch: true });
    expect(
      buildMistralRequest({ ...request(), toolChoice: "none", maxOutputTokens: 0 }),
    ).toMatchObject({
      stream: true,
      store: false,
      tools: [{ type: "web_search" }],
      completion_args: { tool_choice: "none", max_tokens: 0 },
    });
    expect(
      buildMistralRequest({ ...request(), providerOptions: { webSearch: false } }).tools,
    ).toEqual([]);
  });
  it("never reads or replays a hosted activity hint's metadata", () => {
    expect(
      buildMistralRequest({
        ...request(),
        items: [
          {
            item: item({ type: "provider_output", content: [{ type: "text", text: "SECRET" }] }),
            payload: {
              itemId: "i" as ProviderPayload["itemId"],
              provider: "mistral",
              model: "test",
              type: "mistral-output",
              version: 99,
              payload: "SECRET",
            },
          },
        ],
      }).inputs,
    ).toEqual([]);
  });
  it("replays only completely selected native output; foreign/rewound reasoning stays omitted", async () => {
    const output = await events([
      message("commentary"),
      message(
        {
          type: "thinking",
          thinking: [{ type: "text", text: "reason" }],
          signature: "sig",
          vendor: "opaque",
        },
        1,
      ),
      message("answer", 2),
      done,
    ]);
    const items = history(output);
    const full = buildMistralRequest({ ...request(), items });
    expect(full.inputs).toHaveLength(1);
    expect(full.inputs[0]).toMatchObject({
      type: "message.output",
      content: [
        { type: "text", text: "commentary" },
        { type: "thinking", signature: "sig", vendor: "opaque" },
        { type: "text", text: "answer" },
      ],
    });
    const plain = [
      { type: "message.input", role: "assistant", content: "commentary" },
      { type: "message.input", role: "assistant", content: "answer" },
    ];
    expect(
      buildMistralRequest({
        ...request(),
        items,
        modelConfig: { provider: "other", model: "other" },
      }).inputs,
    ).toEqual(plain);
    expect(buildMistralRequest({ ...request(), items: items.slice(0, 2) }).inputs).toEqual(
      plain.slice(0, 1),
    );
    expect(buildMistralRequest({ ...request(), items: items.slice(1) }).inputs).toEqual(
      plain.slice(1),
    );
  });
  it("keeps existing signed reasoning and exact native argument strings from main", () => {
    const entries: ModelRequest["items"] = [
      {
        item: item({ type: "reasoning", content: [] }),
        payload: {
          itemId: "i" as ProviderPayload["itemId"],
          provider: "mistral",
          model: "test",
          type: "mistral-thinking",
          version: 1,
          payload: {
            type: "thinking",
            thinking: [],
            signature: "sig",
            vendor: { secret: "opaque" },
          },
        },
      },
      {
        item: item({ type: "tool_call", callId: "abc123XYZ", name: "echo", args: { x: 1 } }),
        payload: {
          itemId: "i" as ProviderPayload["itemId"],
          provider: "mistral",
          model: "test",
          type: "mistral-tool-arguments",
          version: 1,
          payload: '{ "x" : 1 }',
        },
      },
    ];
    expect(buildMistralRequest({ ...request(), items: entries }).inputs).toMatchObject([
      {
        type: "message.input",
        role: "assistant",
        content: [{ signature: "sig", vendor: { secret: "opaque" } }],
      },
      { type: "function.call", arguments: '{ "x" : 1 }' },
    ]);
  });
  it("preserves object arguments and exact native call/result IDs", () => {
    const inputs = buildMistralRequest({
      ...request(),
      items: [
        {
          item: item({ type: "tool_call", callId: "native-call-id", name: "echo", args: { x: 1 } }),
          payload: {
            itemId: "i" as ProviderPayload["itemId"],
            provider: "mistral",
            model: "test",
            type: "mistral-output",
            version: 1,
            payload: [
              {
                type: "function.call",
                name: "echo",
                tool_call_id: "native-call-id",
                arguments: { x: 1 },
              },
            ],
          },
        },
        {
          item: item({
            type: "tool_result",
            callId: "native-call-id",
            status: "ok",
            content: [{ type: "text", text: "echoed" }],
          }),
        },
      ],
    }).inputs;
    expect(inputs).toEqual([
      { type: "function.call", name: "echo", tool_call_id: "native-call-id", arguments: { x: 1 } },
      { type: "function.result", tool_call_id: "native-call-id", result: "echoed" },
    ]);
  });
});
describe("Mistral stream boundary", () => {
  it("keeps an empty native error message terminally failed", async () => {
    expect(
      (await events([{ type: "conversation.response.error", code: 500, message: "" }])).at(-1),
    ).toEqual({
      type: "completed",
      usage: null,
      error: "Mistral response error (500): ",
    });
  });
  it("accepts nullable model/agent metadata in direct-model streams", async () => {
    const out = await events([{ ...message("text"), model: null, agent_id: null }, done]);
    expect(buildMistralRequest({ ...request(), items: history(out) }).inputs[0]).toMatchObject({
      model: null,
      agent_id: null,
      content: [{ type: "text", text: "text" }],
    });
  });
  it.each(["image_url", "document_url", "tool_file"])(
    "retains readable content/accounting on unsupported %s output",
    async (type) => {
      const out = await events([message("received"), message({ type }, 1), done]);
      expect(out.find((e) => e.type === "message")).toEqual({
        type: "message",
        content: [{ type: "text", text: "received" }],
      });
      expect(out.at(-1)).toMatchObject({
        type: "completed",
        usage: { inputTokens: 10, outputTokens: 5 },
        error: expect.any(String) as unknown,
      });
    },
  );
  it("drains readable output and terminal usage after an unsupported leading chunk", async () => {
    const out = await events([message({ type: "image_url" }), message("received", 1), done]);
    expect(out.find((e) => e.type === "message")).toEqual({
      type: "message",
      content: [{ type: "text", text: "received" }],
    });
    expect(out.at(-1)).toMatchObject({
      type: "completed",
      usage: { inputTokens: 10 },
      error: expect.any(String) as unknown,
    });
  });
  it("keeps references opaque and Markdown unchanged; hosted execution has no replay", async () => {
    const out = await events([
      { type: "tool.execution.started", name: "web_search" },
      message("[Source](https://example.com)"),
      message({ type: "tool_reference", tool: "web_search", url: "https://example.com" }, 1),
      done,
    ]);
    const params = buildMistralRequest({ ...request(), items: history(out) });
    expect(JSON.stringify(params.inputs)).not.toContain("tool.execution");
    expect(params.inputs[0]).toMatchObject({
      content: [{ text: "[Source](https://example.com)" }, { type: "tool_reference" }],
    });
    expect(out[0]).toEqual({
      type: "provider_output",
      content: [{ type: "text", text: "Used web_search." }],
    });
  });
  it("retains opaque-only thinking separately from assistant output", async () => {
    const out = await events([message({ type: "thinking", thinking: [], signature: "sig" }), done]);
    expect(out.find((e) => e.type === "reasoning")).toMatchObject({
      content: [],
      payload: { type: "mistral-output" },
    });
    expect(buildMistralRequest({ ...request(), items: history(out) }).inputs[0]).toMatchObject({
      content: [{ signature: "sig" }],
    });
  });
  it("rejects changed call identity before any tool dispatch", async () => {
    await expect(
      events([
        {
          type: "function.call.delta",
          id: "c",
          name: "echo",
          tool_call_id: "first",
          arguments: "{}",
        },
        {
          type: "function.call.delta",
          id: "c",
          name: "other",
          tool_call_id: "first",
          arguments: "",
        },
      ]),
    ).rejects.toThrow("changed function identity");
  });
});
