import { expect, it } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationId, ModelCallContext, ModelRequest } from "@harness/protocol";
import { httpGateway, json, sse } from "../../litellm/src/http-fixture.ts";
import { OpenCodeGoProvider } from "./provider.ts";

it("sends stable per-conversation session headers and Harness identity on all three real SDK transports", async () => {
  const received: {
    path: string;
    session: unknown;
    cacheKey: unknown;
    expectedSession: unknown;
    agent: unknown;
  }[] = [];
  const gateway = await httpGateway((req, response, raw) => {
    const messages = (req.body.messages ?? req.body.input) as { role: string; content: unknown }[];
    const prompt = messages.findLast(({ role }) => role === "user")?.content;
    const expectedSession =
      typeof prompt === "string"
        ? prompt
        : (prompt as { text: string }[]).map(({ text }) => text).join("");
    received.push({
      path: req.path,
      session: raw.headers["x-opencode-session"],
      cacheKey: req.body.prompt_cache_key,
      expectedSession,
      agent: raw.headers["user-agent"],
    });
    if (!raw.headers["x-opencode-session"])
      return json(
        response,
        {
          error: {
            message: "Request is missing x-opencode-session and cannot be routed efficiently",
          },
        },
        400,
      );
    if (req.path === "/v1/chat/completions")
      sse(response, [
        {
          choices: [{ delta: { content: "chat" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        },
      ]);
    else if (req.path === "/v1/responses")
      sse(
        response,
        [
          { type: "response.output_text.delta", delta: "responses" },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "responses" }],
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 1 } },
          },
        ],
        true,
      );
    else if (req.path === "/v1/messages")
      sse(
        response,
        [
          { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "messages" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ],
        true,
      );
    else json(response, { error: "Unexpected fixture path" }, 404);
  });
  // Shared clients make accidental mutation of default headers observable under concurrency.
  const openai = new OpenAI({ apiKey: "go-fixture", baseURL: `${gateway.url}/v1`, maxRetries: 0 });
  const anthropic = new Anthropic({ apiKey: "go-fixture", baseURL: gateway.url, maxRetries: 0 });
  const shared = new OpenCodeGoProvider({
    openai: { client: async () => openai },
    anthropic: { client: async () => anthropic },
  });
  const contexts: ModelCallContext[] = ["root", "child"].map((id) => ({
    conversationId: id as ConversationId,
  }));
  const run = async (model: string, context: ModelCallContext) => {
    const request: ModelRequest = {
      instructions: [{ type: "text", text: "coding agent" }],
      items: [],
      prompt: context.conversationId,
      modelConfig: { provider: "opencode-go", model },
    };
    const events = [];
    for await (const event of shared.stream(request, AbortSignal.timeout(5000), context))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    expect(events.find(({ type }) => type === "message")).toMatchObject({
      content: [{ type: "text", text: expect.any(String) as unknown }],
    });
  };
  try {
    await Promise.all(
      contexts.flatMap((context) =>
        ["deepseek-v4.1-flash", "gpt-5.6-luna", "minimax-m3"].map((model) => run(model, context)),
      ),
    );
    await run("deepseek-v4.1-flash", contexts[0]!);
    expect(received.every(({ agent }) => agent === `Harness/${PRODUCT_VERSION}`)).toBe(true);
    expect(received.every(({ session, expectedSession }) => session === expectedSession)).toBe(
      true,
    );
    for (const session of ["root", "child"])
      expect(
        new Set(received.filter((request) => request.session === session).map(({ path }) => path)),
      ).toEqual(new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages"]));
    expect(received).toHaveLength(7);
    for (const request of received) {
      expect(request.cacheKey).toBe(request.path === "/v1/messages" ? undefined : request.session);
    }
  } finally {
    await gateway.close();
  }
});
import { PRODUCT_VERSION } from "@harness/release";
