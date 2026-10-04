import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationOf } from "@harness/protocol";
import { z } from "zod";
import { updateGlobalModel, updateGlobalPluginConfig } from "@harness/config";
import type { HarnessEvent, Store } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { EchoTool, FakeProvider, textStep, toolStep } from "@harness/testkit";
import { HarnessService } from "./service.ts";

const serviceOn = (store: Store, steps: ConstructorParameters<typeof FakeProvider>[0]) =>
  new HarnessService({
    store,
    home: "/nonexistent-harness-home", // hermetic: no real global settings
    plugins: [
      { id: "fake", providers: () => [new FakeProvider(steps)], tools: () => [new EchoTool()] },
    ],
  });

describe("HarnessService", () => {
  it("refreshes policy defaults across loaded roots without changing pinned selections, backends or overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-service-defaults-"));
    try {
      const store = new InMemoryStore();
      const service = new HarnessService({
        store,
        home,
        defaults: { model: { provider: "fake", model: "fake-1", preset: "low" } },
        plugins: [
          { id: "fake", providers: () => [new FakeProvider([])] },
          {
            id: "policy",
            configSchema: z.strictObject({ enabled: z.boolean().default(false) }),
            create: () => ({ id: "policy" }),
          },
          {
            id: "backend",
            configSchema: z.strictObject({ mode: z.string().default("original") }),
            create: () => ({ id: "backend" }),
          },
        ],
      });
      const a = await service.createConversation();
      const b = await service.createConversation({
        overrides: { plugins: { policy: { enabled: false } } },
      });
      await service.prepare(a.id);
      await service.prepare(b.id);
      const beforeA = await store.getConversation(a.id);
      const beforeB = await store.getConversation(b.id);
      await updateGlobalModel(home, { provider: "fake", model: "new-default", preset: "high" });
      await updateGlobalPluginConfig(home, "policy", { enabled: true });
      await updateGlobalPluginConfig(home, "backend", { mode: "new-backend" });
      await service.refreshPluginDefaults(["policy"]);
      const configA = service.conversationTreeState(a.id)[0]!.conversation.config;
      const configB = service.conversationTreeState(b.id)[0]!.conversation.config;
      expect(configA.plugins?.policy).toEqual({ enabled: true });
      expect(configB.plugins?.policy).toEqual({ enabled: false });
      for (const config of [configA, configB]) {
        expect(config.model).toEqual({ provider: "fake", model: "fake-1", preset: "low" });
        expect(config.plugins?.backend).toEqual({ mode: "original" });
      }
      expect((await store.getConversation(a.id))?.overrides).toEqual(beforeA?.overrides);
      expect((await store.getConversation(b.id))?.overrides).toEqual(beforeB?.overrides);
      await expect(service.refreshPluginDefaults(["unknown"])).rejects.toThrow("unknown plugin");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("persists model identities without inherited presets and changes presets separately", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-service-model-"));
    try {
      const store = new InMemoryStore();
      const service = new HarnessService({
        store,
        home,
        plugins: [{ id: "fake", providers: () => [new FakeProvider([])] }],
      });
      const conv = await service.createConversation({
        overrides: {
          model: { provider: "fake", model: "old", preset: "high" },
        },
      });

      await service.setModel(conv.id, { provider: "fake", model: "next" });
      expect((await service.getConversation(conv.id))?.config.model).toEqual({
        provider: "fake",
        model: "next",
      });
      await service.setPreset(conv.id, { provider: "fake", model: "next" }, "high");
      expect((await service.getConversation(conv.id))?.config.model).toEqual({
        provider: "fake",
        model: "next",
        preset: "high",
      });
      await service.setModel(conv.id, { provider: "fake", model: "final" });

      const switching = service.setModel(conv.id, { provider: "fake", model: "race-winner" });
      const stalePreset = service.setPreset(conv.id, { provider: "fake", model: "final" }, "high");
      await switching;
      await expect(stalePreset).rejects.toThrow(/model changed before preset update/);

      const global = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as {
        model?: unknown;
      };
      expect((await service.getConversation(conv.id))?.config.model).toEqual({
        provider: "fake",
        model: "race-winner",
      });
      expect(global.model).toEqual({ provider: "fake", model: "race-winner" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("drives a turn and streams the event sequence", async () => {
    const store = new InMemoryStore();
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home", // hermetic: no real global settings
      plugins: [
        {
          id: "fake",
          providers: () => [new FakeProvider([toolStep("c1", "echo", { x: 1 }), textStep("done")])],
          tools: () => [new EchoTool()],
        },
      ],
    });

    const events: HarnessEvent[] = [];
    service.subscribe((e) => events.push(e));

    const conv = await service.createConversation({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    await service.send(conv.id, "hello");
    await service.whenIdle(conv.id);

    expect(events.map((e) => e.type).filter((t) => t !== "inbox")).toEqual([
      "turn.status",
      "item.appended",
      "item.appended",
      "usage.changed",
      "item.appended",
      "text_delta",
      "item.appended",
      "usage.changed",
      "usage.changed",
      "turn.status",
    ]);
  });

  it("scopes a subscription to a single conversation", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("a"), textStep("b")]);
    const overrides = { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } };
    const a = await service.createConversation({ overrides });
    const b = await service.createConversation({ overrides });

    const scoped: HarnessEvent[] = [];
    service.subscribe(a.id, (e) => scoped.push(e));

    await service.send(a.id, "hi");
    await service.whenIdle(a.id);
    await service.send(b.id, "yo");
    await service.whenIdle(b.id);

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => conversationOf(e) === a.id)).toBe(true);
  });

  it("disposes runtime services in reverse registration order and rebuilds them on reload", async () => {
    const store = new InMemoryStore();
    const disposed: string[] = [];
    let builds = 0;
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      plugins: [
        { id: "fake", providers: () => [new FakeProvider([])] },
        {
          id: "execution-owner",
          services: () => [
            {
              key: "execution",
              for: () => ({ id: ++builds }),
              dispose: () => {
                disposed.push("execution");
              },
            },
          ],
        },
        {
          id: "activity-owner",
          services: () => [
            {
              key: "activities",
              for: () => ({ id: ++builds }),
              dispose: () => {
                disposed.push("activities");
              },
            },
          ],
        },
      ],
    });
    const conv = await service.createConversation({
      overrides: { instructions: "", model: { provider: "fake", model: "fake-1" } },
    });

    await service.prepare(conv.id);
    const firstExecution = service.service(conv.id, "execution");
    service.service(conv.id, "activities");
    await expect(service.deactivateSession(conv.id)).resolves.toEqual({
      status: "deactivated",
    });
    expect(disposed).toEqual(["activities", "execution"]);

    await service.prepare(conv.id);
    expect(service.service(conv.id, "execution")).not.toBe(firstExecution);
  });

  it("reports cleanup failures after disposing the remaining services", async () => {
    const store = new InMemoryStore();
    const disposed: string[] = [];
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      plugins: [
        { id: "fake", providers: () => [new FakeProvider([])] },
        {
          id: "one",
          services: () => [
            {
              key: "execution",
              for: () => ({}),
              dispose: () => {
                disposed.push("execution");
              },
            },
          ],
        },
        {
          id: "two",
          services: () => [
            {
              key: "activities",
              for: () => ({}),
              dispose: () => {
                throw new Error("stuck");
              },
            },
          ],
        },
      ],
    });
    const conv = await service.createConversation({
      overrides: { instructions: "", model: { provider: "fake", model: "fake-1" } },
    });
    await service.prepare(conv.id);
    service.service(conv.id, "activities");

    await expect(service.deactivateSession(conv.id)).rejects.toThrow(
      "conversation cleanup failed: activities: Error: stuck",
    );
    expect(disposed).toEqual(["execution"]);
    await expect(service.prepare(conv.id)).resolves.toBeUndefined();
  });

  it("resumes a conversation from the store in a fresh service and continues it", async () => {
    const store = new InMemoryStore();

    // First "process": create a conversation and drive a turn to completion.
    const first = serviceOn(store, [toolStep("c1", "echo", { x: 1 }), textStep("done")]);
    const conv = await first.createConversation({
      overrides: { instructions: "be helpful", model: { provider: "fake", model: "fake-1" } },
    });
    await first.send(conv.id, "hello");
    await first.whenIdle(conv.id);

    // A fresh service attaches to the same store and rehydrates the active chain.
    const second = serviceOn(store, [textStep("welcome back")]);
    expect((await second.getConversation(conv.id))?.id).toBe(conv.id);
    const resumed = await second.getItems(conv.id);
    expect(resumed.map((i) => i.type)).toEqual(["message", "tool_call", "tool_result", "message"]);

    // ...and a deliver continues the conversation it did not create.
    await second.send(conv.id, "still there?");
    await second.whenIdle(conv.id);
    const after = await second.getItems(conv.id);
    expect(after.length).toBe(resumed.length + 2); // new user message + assistant reply
    const lastAssistant = after
      .filter((i) => i.type === "message" && i.role === "assistant")
      .at(-1);
    expect(lastAssistant?.type === "message" && lastAssistant.content).toEqual([
      { type: "text", text: "welcome back" },
    ]);
  });

  it("listConversations skips a conversation whose settings fail to resolve", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("x")]);
    const good = await service.createConversation({
      overrides: { model: { provider: "fake", model: "fake-1" } },
    });
    // Inserted via the store directly — createConversation would (correctly) reject an unknown plugin.
    await store.createConversation({ workspaceRoot: null, overrides: { plugins: { ghost: {} } } });

    expect((await service.listConversations()).map((c) => c.id)).toEqual([good.id]);
  });

  it("createConversation rolls back the record when its settings fail to resolve", async () => {
    const store = new InMemoryStore();
    const service = serviceOn(store, [textStep("x")]);
    await expect(
      service.createConversation({
        overrides: { model: { provider: "fake", model: "fake-1" }, plugins: { ghost: {} } },
      }),
    ).rejects.toThrow(/unknown plugin 'ghost'/);
    expect(await store.listConversations()).toEqual([]);
  });
});
