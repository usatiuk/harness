import { expect, it, vi } from "vitest";
import type { ModelProvider } from "@harness/protocol";
import type { ProviderEntry } from "./auth.ts";
import { bootstrapProviders } from "./provider-bootstrap.ts";

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
