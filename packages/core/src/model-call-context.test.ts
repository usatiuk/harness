import { expect, it } from "vitest";
import type { ModelCallContext, ModelProvider, ModelRequest } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import {
  counterIdGenerator,
  fixedClock,
  newConversationInput,
  testConfigResolver,
  textStep,
} from "@harness/testkit";
import { Engine } from "./engine.ts";
import { PluginHost } from "./plugin-host.ts";
import { modelCompaction } from "./policies.ts";

it("preserves per-conversation identity across retries, concurrent roots, nested children, compaction and resume", async () => {
  const calls: { context: ModelCallContext; request: ModelRequest }[] = [];
  let failFirst = true;
  const provider: ModelProvider = {
    provider: "fake",
    listModels: () => [],
    validateConfig() {},
    capabilities: () => ({
      contentTypes: ["text"],
      toolCalling: true,
      fileTools: "string_replace",
    }),
    async *stream(request, _signal, context) {
      calls.push({ context, request });
      if (failFirst) {
        failFirst = false;
        throw new Error("controlled transport failure");
      }
      yield* textStep(request.prompt ? "summary" : "done");
    },
  };
  const store = new InMemoryStore(counterIdGenerator(), fixedClock());
  const createEngine = () =>
    new Engine(
      store,
      new PluginHost([
        {
          id: "test",
          providers: () => [provider],
          policies: () => ({ compaction: modelCompaction }),
          modelMiddleware: () => [
            {
              id: "retry",
              async *wrap(request, _context, next) {
                try {
                  yield* next(request);
                } catch {
                  yield* next(request);
                }
              },
            },
          ],
        },
      ]),
      testConfigResolver(),
    );
  const config = { instructions: "stable", model: { provider: "fake", model: "fake-1" } };
  const [root, other, child, nested] = await Promise.all(
    Array.from({ length: 4 }, () => store.createConversation(newConversationInput(config))),
  );
  const engine = createEngine();
  await engine.prepare(root!.id);
  engine.registerChild(root!.id, child!.id);
  await engine.prepare(child!.id);
  engine.registerChild(child!.id, nested!.id);
  const input = {
    source: { kind: "user" as const },
    content: [{ type: "text" as const, text: "go" }],
  };
  await Promise.all(
    [root!, other!, child!, nested!].map(async (conversation) => {
      await engine.deliver(conversation.id, input);
      await engine.whenIdle(conversation.id);
    }),
  );
  expect(new Set(calls.map(({ context }) => context.conversationId))).toEqual(
    new Set([root!.id, other!.id, child!.id, nested!.id]),
  );
  const retries = calls.filter(({ request }) => request === calls[0]!.request);
  expect(retries).toHaveLength(2);
  expect(retries[0]!.context).toBe(retries[1]!.context);
  expect(
    (await store.listOwnedItems(root!.id)).some(
      (item) => item.type === "message" && item.role === "assistant",
    ),
  ).toBe(true);
  await engine.compact(child!.id);
  expect(calls.at(-1)).toMatchObject({
    context: { conversationId: child!.id },
  });
  expect(calls.at(-1)?.request.prompt).toContain("compacting");
  await engine.deactivate(root!.id, { force: true });
  const resumed = createEngine();
  await resumed.deliver(root!.id, input);
  await resumed.whenIdle(root!.id);
  expect(calls.at(-1)?.context).toEqual({ conversationId: root!.id });
});
