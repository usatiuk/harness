import { expect, it } from "vitest";
import type { ModelCallContext, ModelProvider } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import {
  FakeProvider,
  newConversationInput,
  testConfigResolver,
  textStep,
  unusedCodeEvaluator,
} from "@harness/testkit";
import { Engine } from "./engine.ts";
import { PluginHost } from "./plugin-host.ts";

it("collects optional model evidence only while capture is enabled", async () => {
  const store = new InMemoryStore();
  const contexts: ModelCallContext[] = [];
  const base: ModelProvider = new FakeProvider([]);
  const provider: ModelProvider = {
    provider: base.provider,
    capabilities: (model) => base.capabilities(model),
    validateConfig: (config) => base.validateConfig(config),
    listModels: () => base.listModels(),
    async *stream(_request, _signal, context) {
      contexts.push(context);
      await context.captureRequest?.({ messages: [{ role: "user", content: "native input" }] });
      yield* textStep("answer");
    },
  };
  let enabled = false;
  const engine = new Engine(
    store,
    new PluginHost([{ id: "test", providers: () => [provider] }]),
    testConfigResolver(),
    unusedCodeEvaluator,
    async () => enabled,
  );
  const conversation = await store.createConversation(
    newConversationInput({ model: { provider: "fake", model: "fake-1" } }),
  );
  for (const capture of [false, true, false]) {
    enabled = capture;
    await engine.deliver(conversation.id, {
      source: { kind: "user" },
      content: [{ type: "text", text: "go" }],
    });
    await engine.whenIdle(conversation.id);
    const item = (await store.listActiveItems(conversation.id)).at(-1)!;
    expect(item).toMatchObject({ type: "message", role: "assistant" });
    const link = (await store.getPluginState(
      "model-evidence",
      conversation.id,
      `item:${item.id}`,
    )) as { attemptId: string } | undefined;
    if (capture) {
      expect(contexts.at(-1)?.captureRequest).toBeTypeOf("function");
      expect(link).toBeDefined();
      expect(
        await store.getPluginState("model-evidence", conversation.id, link!.attemptId),
      ).toMatchObject({
        nativeRequest: { messages: [{ role: "user", content: "native input" }] },
      });
    } else {
      expect(contexts.at(-1)?.captureRequest).toBeUndefined();
      expect(link).toBeUndefined();
    }
  }
  const usage = await store.listModelUsage(conversation.id);
  expect(usage).toHaveLength(3);
  for (const row of usage) expect(await store.getContextBuild(row.contextBuildId!)).toBeDefined();
});
