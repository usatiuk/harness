import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessEvent, Plugin } from "@harness/protocol";
import { readGlobalSettings } from "@harness/config";
import { HarnessService } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { EchoTool } from "@harness/testkit";
import { configuredProviders } from "./provider-fixture.ts";

const fake = vi.hoisted(() => ({
  calls: [] as { params: Record<string, unknown>; signal: AbortSignal }[],
  credentials: [] as { apiKey: string; baseURL?: string }[],
  cancelMode: false,
  onBlocked: undefined as (() => void) | undefined,
}));

vi.mock("@harness/openai-api", () => ({
  apiKeyCredentials: (options: { apiKey: string; baseURL?: string }) => {
    fake.credentials.push(options);
    return {
      client: async () => ({
        chat: {
          completions: {
            create: async (params: Record<string, unknown>, options: { signal: AbortSignal }) => {
              fake.calls.push({ params, signal: options.signal });
              const call = fake.calls.length;
              return {
                async *[Symbol.asyncIterator]() {
                  if (fake.cancelMode) {
                    yield { choices: [{ delta: { content: "partial" } }] };
                    fake.onBlocked?.();
                    await new Promise<void>((resolve) => {
                      if (options.signal.aborted) resolve();
                      else
                        options.signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return;
                  }
                  if (call === 1) {
                    yield {
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call-1",
                                function: { name: "echo", arguments: '{"value":1}' },
                              },
                            ],
                          },
                        },
                      ],
                    };
                    yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
                    yield {
                      choices: [],
                      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: {} },
                    };
                  } else {
                    yield { choices: [{ delta: { content: "done" } }] };
                    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
                    yield {
                      choices: [],
                      usage: { prompt_tokens: 20, completion_tokens: 1, prompt_tokens_details: {} },
                    };
                  }
                },
              };
            },
          },
        },
      }),
    };
  },
}));

const homes: string[] = [];
afterEach(async () => {
  fake.calls.length = 0;
  fake.credentials.length = 0;
  fake.cancelMode = false;
  fake.onBlocked = undefined;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("custom provider public boundary", () => {
  it("runs settings through composition, SDK streaming, tool dispatch, and durable usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-custom-provider-"));
    homes.push(home);
    await writeFile(
      join(home, "settings.json"),
      `${JSON.stringify({
        model: { provider: "local", model: "m", preset: "fast" },
        providers: {
          local: {
            type: "openai-completions-compatible",
            config: {
              endpoint: "http://localhost:8000/v1",
              apiKey: "literal-test-key",
              models: { m: { presets: { fast: { temperature: 0.2 } } } },
            },
          },
        },
      })}\n`,
    );

    const settings = await readGlobalSettings(home);
    const providers = await configuredProviders(settings);
    const tools: Plugin = { id: "tools", tools: () => [new EchoTool()] };
    const service = new HarnessService({
      store: new InMemoryStore(),
      home,
      plugins: [{ id: "configured-provider-instances", providers: () => providers }, tools],
    });
    const conversation = await service.createConversation();
    const events: HarnessEvent[] = [];
    service.subscribe(conversation.id, (event) => events.push(event));

    await service.send(conversation.id, "use echo");
    await service.whenIdle(conversation.id);

    expect(fake.credentials).toEqual([
      { apiKey: "literal-test-key", baseURL: "http://localhost:8000/v1" },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.params).toMatchObject({ model: "m", temperature: 0.2 });
    expect(fake.calls[0]?.params.tools).toMatchObject([
      { type: "function", function: { name: "echo" } },
      { type: "function", function: { name: "tool_describe" } },
      { type: "function", function: { name: "tool_search" } },
    ]);
    expect(fake.calls[1]?.params.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call-1" })]),
    );
    expect((await service.getItems(conversation.id)).map((item) => item.type)).toEqual([
      "message",
      "tool_call",
      "tool_result",
      "message",
    ]);
    expect((await service.usage(conversation.id)).map((row) => row.usage)).toEqual([
      { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0 },
      { inputTokens: 20, outputTokens: 1, cachedReadTokens: 0 },
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["item.appended", "usage.changed"]),
    );
  });

  it("propagates interruption to the custom provider SDK and records unknown accounting", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-custom-provider-"));
    homes.push(home);
    await writeFile(
      join(home, "settings.json"),
      `${JSON.stringify({
        model: { provider: "local", model: "m" },
        providers: {
          local: {
            type: "openai-completions-compatible",
            config: {
              endpoint: "http://localhost:8000/v1",
              apiKey: "literal-test-key",
              models: { m: {} },
            },
          },
        },
      })}\n`,
    );
    const settings = await readGlobalSettings(home);
    const providers = await configuredProviders(settings);
    const service = new HarnessService({
      store: new InMemoryStore(),
      home,
      plugins: [{ id: "configured-provider-instances", providers: () => providers }],
    });
    const conversation = await service.createConversation();
    const events: HarnessEvent[] = [];
    service.subscribe(conversation.id, (event) => events.push(event));
    fake.cancelMode = true;
    const blocked = new Promise<void>((resolve) => (fake.onBlocked = resolve));

    await service.send(conversation.id, "start");
    await blocked;
    await service.deliver(conversation.id, "", "interrupt");
    await service.whenIdle(conversation.id);

    expect(fake.calls[0]?.signal.aborted).toBe(true);
    expect(await service.usage(conversation.id)).toMatchObject([
      { provider: "local", model: "m", purpose: "agent", usage: null, cost: null },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.status", status: "aborted" }),
    );
    expect((await service.getItems(conversation.id)).map((item) => item.type)).toEqual([
      "message",
      "message",
    ]);
  });
});
