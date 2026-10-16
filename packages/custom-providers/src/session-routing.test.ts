import { expect, it } from "vitest";
import type { ConversationId } from "@harness/protocol";
import { httpGateway, sse } from "../../litellm/src/http-fixture.ts";
import { configuredProvider } from "./provider-fixture.ts";

it.each([
  "openai-completions-compatible",
  "openai-responses-compatible",
  "anthropic-compatible",
] as const)("routes concurrent conversations through configured headers over %s", async (type) => {
  const received: { session: unknown; key: unknown }[] = [];
  const gateway = await httpGateway((request, response, raw) => {
    received.push({ session: raw.headers["x-session-id"], key: request.body.prompt_cache_key });
    if (type === "openai-completions-compatible")
      sse(response, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    else if (type === "openai-responses-compatible")
      sse(response, [{ type: "response.completed", response: {} }]);
    else
      sse(
        response,
        [
          { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ],
        true,
      );
  });
  try {
    const provider = await configuredProvider("router", type, {
      endpoint: type === "anthropic-compatible" ? gateway.url : `${gateway.url}/v1`,
      apiKey: "fixture-key",
      sessionIdHeader: "X-Session-Id",
      models: { coding: {} },
    });
    const run = async (id: string) => {
      const context = { conversationId: id as ConversationId };
      const captured: unknown[] = [];
      for await (const event of provider.stream(
        {
          instructions: [],
          items: [],
          prompt: "Hello",
          modelConfig: { provider: "router", model: "coding" },
        },
        AbortSignal.timeout(5000),
        context,
      ))
        captured.push(event);
      expect(captured.at(-1)).toMatchObject({ type: "completed" });
    };
    await Promise.all([run("root"), run("child")]);
    await run("root");
    expect(received.map(({ session }) => session).sort()).toEqual(["child", "root", "root"]);
    for (const { session, key } of received)
      expect(key).toBe(type === "anthropic-compatible" ? undefined : session);
  } finally {
    await gateway.close();
  }
});
