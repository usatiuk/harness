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

it("adds manual models and overrides known Codex metadata independently", () => {
  const provider = createCodexProvider({} as CodexAuth, CODEX_PROVIDER, false, {
    "gpt-6.1-sol": {
      preferredEditTool: "replace",
      customToolInput: { supported: false, grammars: [] },
      maxInputTokens: 123_000,
    },
    "manual-model": { label: "Manual", maxOutputTokens: 8192 },
  });
  expect(provider.capabilities("gpt-6.1-sol")).toMatchObject({
    preferredEditTool: "replace",
    customToolInput: { supported: false, grammars: [] },
  });
  expect(provider.listModels().find((model) => model.model === "gpt-6.1-sol")).toMatchObject({
    maxInputTokens: 123_000,
  });
  expect(provider.listModels().find((model) => model.model === "manual-model")).toEqual({
    provider: CODEX_PROVIDER,
    model: "manual-model",
    label: "Manual",
    maxOutputTokens: 8192,
  });
  expect(provider.capabilities("manual-model")).toMatchObject({
    preferredEditTool: "replace",
    customToolInput: { supported: false, grammars: [] },
  });
});

it("discovers Codex patch recommendations through authenticated catalog requests, with config last", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    expect(url.pathname).toBe("/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toMatch(/^\d+\.\d+\.\d+/);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("ChatGPT-Account-ID")).toBe("test-account");
    return Response.json({
      models: [
        { slug: "gpt-6.1-sol", apply_patch_tool_type: "freeform", ignored: "native settings" },
        { slug: "new-model", apply_patch_tool_type: "freeform" },
      ],
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const auth = {
      getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
    } as unknown as CodexAuth;
    const provider = createCodexProvider(auth, CODEX_PROVIDER, false, {
      "gpt-6.1-sol": { preferredEditTool: "replace" },
      "manual-model": { label: "Manual" },
    });
    expect(await provider.refreshModels(new AbortController().signal)).toEqual({
      status: "ready",
      diagnostics: [],
    });
    expect(provider.listModels().map((model) => model.model)).toEqual([
      "gpt-6.1-sol",
      "new-model",
      "manual-model",
    ]);
    expect(provider.capabilities("gpt-6.1-sol")).toMatchObject({
      preferredEditTool: "replace",
      customToolInput: { supported: true, grammars: ["lark"] },
    });
    expect(provider.capabilities("new-model")).toMatchObject({
      preferredEditTool: "patch",
      customToolInput: { supported: false, grammars: [] },
    });
    expect(
      provider.listModels().find((model) => model.model === "new-model")?.maxOutputTokens,
    ).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("leaves the last Codex catalog intact after invalid discovery or cancellation", async () => {
  const abort = new AbortController();
  const auth = {
    getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
  } as unknown as CodexAuth;
  const provider = createCodexProvider(auth, CODEX_PROVIDER);
  const original = provider.listModels();
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ models: [{ slug: "broken", apply_patch_tool_type: 42 }] }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(provider.refreshModels(abort.signal)).rejects.toMatchObject({
      name: "ModelDiscoveryError",
      code: "invalid-response",
    });
    expect(provider.listModels()).toEqual(original);
    const cancellation = new Error("cancelled");
    fetch.mockImplementation(async () => {
      abort.abort(cancellation);
      return Response.json({ models: [] });
    });
    await expect(provider.refreshModels(abort.signal)).rejects.toBe(cancellation);
    expect(provider.listModels()).toEqual(original);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    response: () =>
      Response.json({
        models: [
          {
            slug: "invalid-effort",
            supported_reasoning_levels: [{ effort: "", description: "Empty" }],
          },
        ],
      }),
    code: "invalid-response",
  },
  {
    response: () =>
      Response.json({
        models: [
          {
            slug: "invalid-default",
            supported_reasoning_levels: [{ effort: "high", description: "High" }],
            default_reasoning_level: "medium",
          },
        ],
      }),
    code: "invalid-response",
  },
  {
    response: () => Response.json({ models: [{ slug: "duplicate" }, { slug: "duplicate" }] }),
    code: "invalid-response",
  },
  { response: () => Response.json({ detail: "unavailable" }, { status: 503 }), code: "http" },
  { response: () => new Response("x".repeat(2 * 1024 * 1024 + 1)), code: "limit" },
])(
  "preserves the previous catalog on classified $code discovery failure",
  async ({ response, code }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    try {
      const auth = {
        getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
      } as unknown as CodexAuth;
      const provider = createCodexProvider(auth, CODEX_PROVIDER);
      const original = provider.listModels();
      await expect(provider.refreshModels(new AbortController().signal)).rejects.toMatchObject({
        name: "ModelDiscoveryError",
        code,
      });
      expect(provider.listModels()).toEqual(original);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["request", "body"])(
  "only classifies recognized %s transport failures",
  async (boundary) => {
    const defect = new Error("fixture defect");
    const transport = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    });
    let failure = defect;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (boundary === "request") throw failure;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        );
      }),
    );
    try {
      const auth = {
        getValidSession: async () => ({ accessToken: "test-token", accountId: "test-account" }),
      } as unknown as CodexAuth;
      const provider = createCodexProvider(auth, CODEX_PROVIDER);
      const original = provider.listModels();
      await expect(provider.refreshModels(new AbortController().signal)).rejects.toMatchObject(
        boundary === "request" ? { cause: defect } : defect,
      );
      expect(provider.listModels()).toEqual(original);
      failure = transport;
      await expect(provider.refreshModels(new AbortController().signal)).rejects.toMatchObject({
        name: "ModelDiscoveryError",
        code: "network",
      });
      expect(provider.listModels()).toEqual(original);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("uses discovered native effort controls for a new Codex model", async () => {
  let body: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_input, init) => {
      if (!init?.body)
        return Response.json({
          models: [
            {
              slug: "new-reasoning-model",
              supported_reasoning_levels: [
                { effort: "high", description: "High effort" },
                { effort: "xhigh", description: "Extra high effort" },
              ],
              default_reasoning_level: "high",
            },
            { slug: "unknown-controls" },
            {
              slug: "extensible-efforts",
              supported_reasoning_levels: [
                { effort: "persistent", description: "Provider-defined" },
              ],
              default_reasoning_level: "persistent",
            },
          ],
        });
      if (typeof init.body !== "string") throw new Error("Expected JSON request body");
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
    await provider.refreshModels(new AbortController().signal);
    expect(
      provider.listModels().find(({ model }) => model === "new-reasoning-model"),
    ).toMatchObject({
      presets: [{ value: "high" }, { value: "xhigh" }],
      defaultPreset: "high",
    });
    expect(() =>
      provider.validateConfig({
        provider: CODEX_PROVIDER,
        model: "new-reasoning-model",
        preset: "medium",
      }),
    ).toThrow("unknown preset");
    for (const model of ["new-reasoning-model", "unknown-controls", "extensible-efforts"]) {
      for await (const event of provider.stream(
        { modelConfig: { provider: CODEX_PROVIDER, model }, instructions: [], items: [] },
        new AbortController().signal,
        { conversationId: "test" } as ModelCallContext,
      ))
        void event;
      expect(body).toMatchObject({
        model,
        reasoning:
          model === "new-reasoning-model"
            ? { effort: "high" }
            : model === "extensible-efforts"
              ? { effort: "persistent" }
              : { summary: "auto" },
      });
      if (model === "unknown-controls")
        expect((body as { reasoning: { effort?: string } }).reasoning.effort).toBeUndefined();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
