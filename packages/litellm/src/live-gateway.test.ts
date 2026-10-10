import { expect, it } from "vitest";
import type { ConversationId, Item, ModelRequest, ModelStreamEvent } from "@harness/protocol";
import { LiteLLMProvider } from "./provider.ts";
import { liteLLMConfigSchema, type Transport } from "./config.ts";
import { httpGateway, json, sse } from "./http-fixture.ts";
import { dockerGateway } from "./docker-fixture.ts";

async function collect(provider: LiteLLMProvider, request: ModelRequest) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(request, AbortSignal.timeout(15_000), {
    conversationId: "fixture" as ConversationId,
  }))
    events.push(event);
  return events;
}
function item(seq: number, fields: Record<string, unknown>): Item {
  return {
    id: `item-${seq}`,
    conversationId: "fixture",
    turnId: "turn",
    seq,
    parent: null,
    createdAt: seq,
    ...fields,
  } as Item;
}
function next(first: ModelStreamEvent[], request: ModelRequest): ModelRequest {
  const items: ModelRequest["items"] = [];
  for (const event of first) {
    if (event.type === "reasoning") {
      const reasoning = item(items.length, { type: "reasoning", content: event.content });
      items.push({
        item: reasoning,
        ...(event.payload ? { payload: { ...event.payload, itemId: reasoning.id } } : {}),
      });
    }
    if (event.type === "tool_call")
      items.push({
        item: item(items.length, {
          type: "tool_call",
          callId: event.callId,
          name: event.name,
          args: event.args,
        }),
      });
  }
  items.push({
    item: item(items.length, {
      type: "tool_result",
      callId: "call-1",
      status: "ok",
      content: [{ type: "text", text: "echoed" }],
    }),
  });
  const continuation = { ...request, items };
  delete continuation.prompt;
  return continuation;
}

// Real LiteLLM auth/routing/streaming; controlled upstream enforces fidelity and origin binding.
// Vendor cryptographic acceptance is a separate credential-gated qualification.
it.skipIf(process.env.HARNESS_LITELLM_DOCKER !== "1")(
  "qualifies restricted catalogs and three native routes through LiteLLM v1.103.2",
  async () => {
    const failures: string[] = [];
    const upstream = await httpGateway((req, res) => {
      const origin = req.path.includes("origin-b") ? "b" : "a";
      const body = JSON.stringify(req.body);
      const continuation = body.includes("echoed");
      if (req.method === "GET" && req.path.endsWith("/models"))
        return json(res, { object: "list", data: [] });
      if (
        continuation &&
        req.path.endsWith("/responses") &&
        (!body.includes(`CIPHER-${origin}`) || !body.includes(`"id":"rs_${origin}"`))
      ) {
        failures.push("Responses origin/ciphertext mismatch");
        return json(
          res,
          { error: { message: "origin mismatch", type: "invalid_request_error" } },
          400,
        );
      }
      if (req.path.endsWith("/responses")) {
        const output = continuation
          ? [
              {
                type: "message",
                id: "msg-1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              },
            ]
          : [
              {
                type: "reasoning",
                id: `rs_${origin}`,
                summary: [{ type: "summary_text", text: "thought" }],
                encrypted_content: `CIPHER-${origin}`,
              },
              {
                type: "function_call",
                id: "fc-1",
                call_id: "call-1",
                name: "echo",
                arguments: '{"x":1}',
                status: "completed",
              },
            ];
        const response = {
          id: `resp_${origin}`,
          object: "response",
          created_at: 1,
          model: "o3",
          status: "completed",
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        };
        return sse(res, [
          {
            type: "response.created",
            sequence_number: 0,
            response: { ...response, status: "in_progress", output: [] },
          },
          ...output.flatMap((entry, output_index) => [
            {
              type: "response.output_item.added",
              sequence_number: output_index * 3 + 1,
              output_index,
              item: entry,
            },
            ...(continuation
              ? [
                  {
                    type: "response.output_text.delta",
                    sequence_number: output_index * 3 + 2,
                    output_index,
                    content_index: 0,
                    item_id: "msg-1",
                    delta: "done",
                  },
                ]
              : []),
            {
              type: "response.output_item.done",
              sequence_number: output_index * 3 + 3,
              output_index,
              item: entry,
            },
          ]),
          { type: "response.completed", sequence_number: output.length * 3 + 1, response },
        ]);
      }
      if (req.path.endsWith("/messages")) {
        if (continuation && !body.includes("SIGNATURE")) {
          failures.push("Messages signature lost");
          return json(res, { error: { message: "signature missing" } }, 400);
        }
        return sse(
          res,
          [
            {
              type: "message_start",
              message: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            ...(continuation
              ? [
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
                ]
              : [
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
                ]),
            {
              type: "message_delta",
              delta: { stop_reason: continuation ? "end_turn" : "tool_use", stop_sequence: null },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          ],
          true,
        );
      }
      return sse(res, [
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              delta: continuation
                ? { content: "done" }
                : {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: { name: "echo", arguments: '{"x":1}' },
                      },
                    ],
                  },
              finish_reason: continuation ? "stop" : "tool_calls",
            },
          ],
        },
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]);
    }, "0.0.0.0");
    const upstreamBase = upstream.url.replace("127.0.0.1", "host.docker.internal");
    const deployment = (alias: string, model: string, transport: Transport, origin: string) => ({
      model_name: alias,
      litellm_params: {
        model,
        api_key: `upstream-fixture-${origin}`,
        api_base: `${upstreamBase}/origin-${origin}${transport === "anthropic-messages" ? "" : "/v1"}`,
      },
      model_info: {
        id: `${alias}-${origin}`,
        mode: transport === "openai-responses" ? "responses" : "chat",
        harness: {
          version: 1,
          transport,
          ...(transport === "anthropic-messages" ? { thinking: { type: "adaptive" } } : {}),
        },
      },
    });
    let gateway: Awaited<ReturnType<typeof dockerGateway>> | undefined;
    try {
      gateway = await dockerGateway([
        deployment("chat", "openai/gpt-4o", "openai-completions", "a"),
        deployment("responses", "openai/o3", "openai-responses", "a"),
        deployment("responses", "openai/o3", "openai-responses", "b"),
        deployment("responses-a", "openai/o3", "openai-responses", "a"),
        deployment("responses-b", "openai/o3", "openai-responses", "b"),
        deployment("messages", "anthropic/claude-sonnet-4-5", "anthropic-messages", "a"),
      ]);
      const work = new LiteLLMProvider(
        "work",
        liteLLMConfigSchema.parse({ baseUrl: gateway.url }),
        await gateway.key(["responses", "responses-a", "responses-b", "messages"]),
      );
      const personalKey = await gateway.key(["chat"]);
      const personal = new LiteLLMProvider(
        "personal",
        liteLLMConfigSchema.parse({ baseUrl: gateway.url }),
        personalKey,
      );
      await Promise.all([
        work.refreshModels(AbortSignal.timeout(10_000)),
        personal.refreshModels(AbortSignal.timeout(10_000)),
      ]);
      expect(
        work
          .listModels()
          .map((model) => model.model)
          .sort(),
      ).toEqual(["messages", "responses", "responses-a", "responses-b"]);
      expect(personal.listModels().map((model) => model.model)).toEqual(["chat"]);
      const denied = await fetch(`${gateway.url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${personalKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "responses", input: "Denied fixture invocation" }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(denied.status).toBe(403);
      await denied.body?.cancel();
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      for (const [provider, model] of [
        [personal, "chat"],
        [work, "responses"],
        [work, "responses-a"],
        [work, "responses-b"],
        [work, "messages"],
      ] as const) {
        const request: ModelRequest = {
          modelConfig: { provider: provider.provider, model },
          instructions: [],
          prompt: "Call echo",
          items: [],
          tools: [
            {
              kind: "function",
              name: "echo",
              description: "Echo",
              parameters: { type: "object", properties: { x: { type: "number" } } },
            },
          ],
        };
        const first = await collect(provider, request);
        expect(first.find((event) => event.type === "tool_call")).toMatchObject({
          callId: "call-1",
          name: "echo",
          args: { x: 1 },
        });
        expect(first.find((event) => event.type === "completed")).toMatchObject({
          usage: { inputTokens: 10, outputTokens: 5 },
        });
        if (model !== "chat")
          expect(first.find((event) => event.type === "reasoning")).toMatchObject({
            payload: { provider: "work", model },
          });
        const second = await collect(provider, next(first, request));
        expect(second).toContainEqual({ type: "text_delta", text: "done" });
        expect(second.find((event) => event.type === "message")).toMatchObject({
          content: [{ type: "text", text: "done" }],
        });
        expect(second.findIndex((event) => event.type === "text_delta")).toBeLessThan(
          second.findIndex((event) => event.type === "message"),
        );
        expect(second.at(-1)).toMatchObject({ type: "completed" });
      }
      const responses = upstream.requests.filter((req) => req.path.endsWith("/responses"));
      expect(responses).toHaveLength(6);
      expect(responses[1]!.path).toBe(responses[0]!.path);
      expect(responses.slice(2).map((req) => req.path)).toEqual([
        "/origin-a/v1/responses",
        "/origin-a/v1/responses",
        "/origin-b/v1/responses",
        "/origin-b/v1/responses",
      ]);
      expect(responses[1]!.body.previous_response_id).toBeUndefined();
      expect(failures).toEqual([]);
    } finally {
      await gateway?.close();
      await upstream.close();
    }
  },
  180_000,
);
