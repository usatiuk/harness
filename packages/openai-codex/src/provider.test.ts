import { describe, expect, it, vi } from "vitest";
import type { Item, ModelCallContext, ModelStreamEvent } from "@harness/protocol";
import type { CodexAuth } from "./auth.ts";
import { CODEX_PROVIDER, createCodexProvider } from "./provider.ts";

describe("createCodexProvider", () => {
  it("carries provider-owned native search settings through the shared Responses provider", () => {
    expect(createCodexProvider({} as CodexAuth, CODEX_PROVIDER).providerOptions).toEqual({
      webSearch: false,
    });
    expect(createCodexProvider({} as CodexAuth, "named-codex", true).providerOptions).toEqual({
      webSearch: true,
    });
  });

  it("exposes the current ChatGPT roster with Codex capacity and effort controls", () => {
    const provider = createCodexProvider({} as CodexAuth, CODEX_PROVIDER);
    const gpt = provider.listModels().find((model) => model.model === "gpt-5.5");

    expect(provider.provider).toBe(CODEX_PROVIDER);
    expect(gpt?.contextWindow).toBeUndefined();
    expect(gpt?.maxInputTokens).toBe(400_000);
    expect(gpt?.maxOutputTokens).toBe(128_000);
    const models = provider.listModels();
    expect(models.map((entry) => entry.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(models.find((entry) => entry.model === "gpt-6.1-sol")?.defaultPreset).toBe("low");
    for (const model of models) {
      expect(model.supportsImages).toBe(true);
      expect(model.contextWindow).toBeUndefined();
      expect(model.maxInputTokens).toBe(model.model === "gpt-6.1-sol" ? 628_000 : 400_000);
      expect(model.maxOutputTokens).toBe(128_000);
      expect(model.presets?.map((entry) => entry.value)).not.toContain("none");
      expect(model.presets?.map((entry) => entry.value)).not.toContain("ultra");
    }
  });
});

it("sends user and tool images through authenticated Codex Responses transport", async () => {
  let body: unknown;
  let requestHeaders = new Headers();
  let requestUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestHeaders = new Headers(init?.headers);
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as unknown;
      return new Response('data: {"type":"response.completed","response":{"usage":null}}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    }),
  );
  try {
    const auth = {
      getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
    } as unknown as CodexAuth;
    const provider = createCodexProvider(auth, CODEX_PROVIDER);
    const image = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
    const base = {
      conversationId: "conversation",
      turnId: "turn",
      seq: 0,
      parent: null,
      createdAt: 0,
    };
    const items = [
      { ...base, id: "user", type: "message", role: "user", content: [image] },
      { ...base, id: "call", type: "tool_call", callId: "read", name: "read_image", args: {} },
      {
        ...base,
        id: "result",
        type: "tool_result",
        callId: "read",
        status: "ok",
        content: [image],
      },
    ] as Item[];
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream(
      {
        modelConfig: { provider: CODEX_PROVIDER, model: "gpt-6.1-sol" },
        instructions: [],
        items: items.map((item) => ({ item })),
      },
      new AbortController().signal,
      { conversationId: "conversation" } as ModelCallContext,
    ))
      events.push(event);
    expect(requestUrl).toContain("/codex/responses");
    expect(requestHeaders.get("authorization")).toBe("Bearer test-token");
    expect(requestHeaders.get("ChatGPT-Account-ID")).toBe("test-account");
    const nativeImage = {
      type: "input_image",
      image_url: `data:${image.mediaType};base64,${image.data}`,
      detail: "auto",
    };
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      stream: true,
      store: false,
      input: [
        { role: "user", content: [nativeImage] },
        { type: "function_call", call_id: "read", name: "read_image", arguments: "{}" },
        { type: "function_call_output", call_id: "read", output: [nativeImage] },
      ],
    });
    expect(events.map((event) => event.type)).toEqual(["completed"]);
    expect(items[0]).toMatchObject({ content: [image] });
  } finally {
    vi.unstubAllGlobals();
  }
});
