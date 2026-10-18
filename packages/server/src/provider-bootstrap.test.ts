import { expect, it, vi } from "vitest";
import type { ModelProvider } from "@harness/protocol";
import type { ProviderEntry } from "./auth.ts";
import { bootstrapProviders } from "./provider-bootstrap.ts";
import { MemorySecretStore } from "@harness/secrets";
import { providerEntries } from "./auth.ts";

it("bootstraps the built-in Codex roster and configured models without catalog requests", async () => {
  const store = new MemorySecretStore();
  await store.set(
    "provider-instance:openai-codex:oauth",
    JSON.stringify({
      accessToken: "test-token",
      refreshToken: "test-refresh",
      idToken: "test-id",
      accountId: "test-account",
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  // This is the successful-but-empty response that erased the roster in 0.8.0.
  const fetch = vi.fn(async () => Response.json({ models: [] }));
  vi.stubGlobal("fetch", fetch);
  try {
    const entries = providerEntries(store, {
      providers: {
        "openai-codex": {
          type: "openai-codex",
          config: {
            models: {
              "gpt-6.1-sol": { preferredEditTool: "replace", maxInputTokens: 123_000 },
              "manual-model": { label: "Manual", presets: ["high"], defaultPreset: "high" },
            },
          },
        },
      },
    });
    const codex = entries.get("openai-codex")!;
    const boot = await bootstrapProviders(
      new Map([[codex.id, codex]]),
      new AbortController().signal,
    );
    expect(boot.statuses.get(codex.id)).toMatchObject({
      authenticated: true,
      registered: true,
      catalog: "ready",
      modelCount: 8,
      diagnostics: [],
    });
    const provider = boot.plugin.providers!()[0]!;
    const models = provider.listModels();
    expect(models.map(({ model }) => model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "manual-model",
    ]);
    expect(models[0]).toMatchObject({ maxInputTokens: 123_000 });
    expect(provider.capabilities("gpt-6.1-sol").preferredEditTool).toBe("replace");
    expect(models.at(-1)).toMatchObject({
      label: "Manual",
      presets: [{ value: "high" }],
      defaultPreset: "high",
    });
    provider.validateConfig({ provider: codex.id, model: "manual-model", preset: "high" });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function entry(id: string, provider: Partial<ModelProvider>): ProviderEntry {
  return {
    id,
    label: id,
    type: "fixture",
    config: {},
    settings: [],
    instance: {
      buildProvider: async () => ({
        provider: id,
        listModels: () => [],
        capabilities: () => ({
          contentTypes: ["text"],
          toolCalling: true,
          customToolInput: { supported: false, grammars: [] },
          preferredEditTool: "replace",
        }),
        validateConfig() {},
        async *stream() {},
        ...provider,
      }),
    },
  };
}

it("does not turn a deterministic provider defect into a catalog timeout", async () => {
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(AbortSignal.abort(new DOMException("Deadline", "TimeoutError")));
  const defect = new TypeError("Fixture deterministic defect");
  try {
    await expect(
      bootstrapProviders(
        new Map([
          [
            "work",
            entry("work", {
              async refreshModels() {
                throw defect;
              },
            }),
          ],
        ]),
        new AbortController().signal,
      ),
    ).rejects.toBe(defect);
  } finally {
    timeout.mockRestore();
  }
});

it("aborts and drains sibling discovery before reporting a packaged provider defect", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let abortSeen!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortSeen = resolve;
  });
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const defect = new Error("fixture defect");
  const entries = new Map([
    [
      "held",
      entry("held", {
        async refreshModels(signal) {
          began();
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                abortSeen();
                resolve();
              },
              { once: true },
            ),
          );
          await cleanup;
          signal.throwIfAborted();
          return { status: "ready", diagnostics: [] };
        },
      }),
    ],
    [
      "broken",
      entry("broken", {
        async refreshModels() {
          await started;
          throw defect;
        },
      }),
    ],
  ]);
  let completed = false;
  const startup = bootstrapProviders(entries, new AbortController().signal);
  const rejection = expect(startup).rejects.toBe(defect);
  void startup.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await aborted;
  expect(completed).toBe(false);
  finish();
  await rejection;
  expect(completed).toBe(true);
});

it.each([
  { models: [{ provider: "another", model: "coding" }] },
  {
    models: [
      { provider: "work", model: "coding" },
      { provider: "work", model: "coding" },
    ],
  },
])("rejects inconsistent plugin-owned catalog identities", async ({ models }) => {
  await expect(
    bootstrapProviders(
      new Map([["work", entry("work", { listModels: () => models })]]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invalid model catalog");
});

it("bounds the actual expanded wire catalog rather than its smaller internal descriptions", async () => {
  const models = Array.from({ length: 20000 }, (_, index) => ({
    provider: "work",
    model: `alias-${index}`,
  }));
  expect(Buffer.byteLength(JSON.stringify(models))).toBeLessThan(3 * 1024 * 1024);
  await expect(
    bootstrapProviders(
      new Map([["work", entry("work", { listModels: () => models })]]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("3 MiB RPC budget");
});
