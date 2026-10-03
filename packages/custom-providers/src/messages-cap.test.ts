import { expect, it, vi } from "vitest";
import { configuredProvider } from "./provider-fixture.ts";

const edge = vi.hoisted(() => ({
  reached: new Error("Reached SDK boundary"),
  params: undefined as Record<string, unknown> | undefined,
}));
vi.mock("@harness/anthropic-api", () => ({
  apiKeyCredentials: () => ({
    client: async () => ({
      messages: {
        create: async (params: Record<string, unknown>) => {
          edge.params = params;
          throw edge.reached;
        },
      },
    }),
  }),
}));

it("sends an invocation cap instead of a compatible model/preset default", async () => {
  const provider = await configuredProvider("local", "anthropic-compatible", {
    endpoint: "http://localhost:8787",
    apiKey: "fixture-key",
    models: { coding: { maxOutputTokens: 65536, presets: { short: { maxTokens: 8192 } } } },
  });
  const invocation = (async () => {
    for await (const event of provider.stream(
      {
        instructions: [],
        items: [],
        maxOutputTokens: 4096,
        modelConfig: { provider: "local", model: "coding", preset: "short" },
      },
      new AbortController().signal,
    ))
      void event;
  })();
  await expect(invocation).rejects.toBe(edge.reached);
  expect(edge.params?.max_tokens).toBe(4096);
  expect(provider.listModels()[0]?.maxOutputTokens).toBe(65536);
});
