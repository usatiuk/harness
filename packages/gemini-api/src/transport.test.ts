import { afterEach, expect, it, vi } from "vitest";
import type { ModelRequest, ModelStreamEvent, ProviderPayload } from "@harness/protocol";
import { GeminiProvider } from "./provider.ts";

afterEach(() => vi.unstubAllGlobals());
const request = (provider: GeminiProvider): ModelRequest => ({
  instructions: [],
  items: [],
  prompt: "go",
  tools: [{ kind: "function", name: "echo", description: "echo", parameters: { type: "object" } }],
  modelConfig: { provider: provider.provider, model: "gemini-test" },
  providerOptions: provider.providerOptions,
});
const collect = async (stream: AsyncIterable<ModelStreamEvent>) => {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

it("uses the installed Google SDK for discovery and finalized signed search history on a later request", async () => {
  const sent: Request[] = [];
  const steps = [
    { type: "thought", summary: [{ type: "text", text: "reason" }], signature: "SIGNATURE" },
    {
      type: "google_search_call",
      id: "search",
      arguments: { queries: ["example"] },
      signature: "CALL_SIGNATURE",
    },
    { type: "google_search_result", call_id: "search", result: [], signature: "RESULT_SIGNATURE" },
    { type: "model_output", content: [{ type: "text", text: "[Source](https://example.com)" }] },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      sent.push(req.clone());
      return Response.json(
        req.method === "GET"
          ? {
              models: [
                {
                  name: "models/gemini-test",
                  displayName: "Gemini test",
                  supportedGenerationMethods: ["generateContent"],
                  inputTokenLimit: 10000,
                  outputTokenLimit: 1000,
                  thinking: true,
                },
                {
                  name: "models/gemini-test-image",
                  supportedGenerationMethods: ["generateContent"],
                },
                { name: "models/gemini-test-tts", supportedGenerationMethods: ["generateContent"] },
              ],
            }
          : {
              id: "interaction",
              status: "completed",
              steps,
              usage: { total_input_tokens: 10, total_output_tokens: 5 },
            },
      );
    }),
  );
  const provider = new GeminiProvider({ provider: "gemini", apiKey: "test", webSearch: true });
  const signal = new AbortController().signal;
  await expect(provider.refreshModels(signal)).resolves.toMatchObject({ status: "ready" });
  expect(provider.listModels()).toEqual([
    {
      provider: "gemini",
      model: "gemini-test",
      label: "Gemini test",
      maxInputTokens: 10000,
      maxOutputTokens: 1000,
      reasoning: { supported: true },
    },
  ]);
  const events = await collect(provider.stream(request(provider), signal));
  expect(sent[1]!.url).toContain("/interactions");
  expect(await sent[1]!.json()).toMatchObject({
    store: false,
    tools: [{ type: "function", name: "echo" }, { type: "google_search" }],
    generation_config: { thinking_summaries: "auto" },
  });
  expect(events.map((event) => event.type)).toEqual([
    "reasoning",
    "provider_output",
    "message",
    "completed",
  ]);
  const items: ModelRequest["items"] = events.flatMap((event) =>
    event.type === "message" || event.type === "reasoning" || event.type === "provider_output"
      ? [
          {
            item: {
              id: "i",
              conversationId: "c",
              turnId: "t",
              seq: 0,
              parent: null,
              createdAt: 0,
              ...event,
              ...(event.type === "message" ? { role: "assistant" as const } : {}),
            } as ModelRequest["items"][number]["item"],
            ...(event.payload
              ? { payload: { ...event.payload, itemId: "i" as ProviderPayload["itemId"] } }
              : {}),
          },
        ]
      : [],
  );
  await collect(provider.stream({ ...request(provider), items }, signal));
  expect(sent).toHaveLength(3);
  const next = (await sent[2]!.json()) as Record<string, unknown>;
  expect(next.input).toEqual([
    ...steps,
    { type: "user_input", content: [{ type: "text", text: "go" }] },
  ]);
  expect(next).not.toHaveProperty("continuation_token");
  expect(next).not.toHaveProperty("previous_interaction_id");
  expect(JSON.stringify(next)).not.toContain("Searched example");
});

it("propagates cancellation to the SDK fetch without retrying", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let networkSignal: AbortSignal | undefined;
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    networkSignal = new Request(input, init).signal;
    entered();
    return new Promise<Response>((_resolve, reject) => {
      networkSignal!.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetch);
  const provider = new GeminiProvider({ provider: "gemini", apiKey: "test", webSearch: true });
  const controller = new AbortController();
  const pending = collect(provider.stream(request(provider), controller.signal));
  const rejected = expect(pending).rejects.toThrow();
  await started;
  controller.abort();
  await rejected;
  expect(networkSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("drains a received SDK response and accounting when cancellation wins after body receipt", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    const response = Response.json({
      id: "interaction",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Received" }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 5 },
    });
    const readText = response.text.bind(response);
    const readJson = response.json.bind(response);
    vi.spyOn(response, "text").mockImplementation(async () => {
      const text = await readText();
      controller.abort();
      return text;
    });
    vi.spyOn(response, "json").mockImplementation(async (): Promise<unknown> => {
      const body: unknown = await readJson();
      controller.abort();
      return body;
    });
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  const provider = new GeminiProvider({ provider: "gemini", apiKey: "test" });
  const events = await collect(provider.stream(request(provider), controller.signal));
  expect(controller.signal.aborted).toBe(true);
  expect(events).toMatchObject([
    { type: "message", content: [{ type: "text", text: "Received" }] },
    { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
