import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isKernelEvent } from "@harness/protocol";
import { InMemoryStore } from "@harness/store";
import { FakeProvider, GateProvider } from "@harness/testkit";
import { HarnessService } from "./service.ts";

describe("parallel conversation configuration", () => {
  it("interrupts B while A's configuration persistence is held", async () => {
    const store = new InMemoryStore();
    const provider = new GateProvider("B is streaming");
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      defaults: { model: { provider: "fake", model: "first" } },
      plugins: [
        { id: "fake", providers: () => [provider] },
        {
          id: "audit",
          configSchema: z.strictObject({ enabled: z.boolean().default(false) }),
          create: () => ({ id: "audit" }),
        },
      ],
    });
    const a = await service.createConversation(),
      b = await service.createConversation();
    const statuses: string[] = [];
    service.subscribe(b.id, (event) => {
      if (isKernelEvent(event) && event.type === "turn.status") statuses.push(event.status);
    });
    await Promise.all([service.prepare(a.id), service.prepare(b.id)]);
    await service.send(b.id, "start B");
    await provider.started;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const update = store.updateConversationOverrides.bind(store);
    vi.spyOn(store, "updateConversationOverrides").mockImplementation(async (id, patch) => {
      if (id === a.id) {
        entered();
        await gate;
      }
      return update(id, patch);
    });
    const mutation = service.setPluginConfig(a.id, "audit", { enabled: true });
    await writing;
    try {
      await service.deliver(b.id, "", "interrupt");
      await service.whenIdle(b.id);
      expect(statuses.at(-1)).toBe("aborted");
    } finally {
      release();
      await mutation;
      await Promise.all([service.deactivateSession(a.id), service.deactivateSession(b.id)]);
    }
  });

  it("pins model and preset through global changes, reload, and service recreation", async () => {
    const home = await mkdtemp(join(tmpdir(), "harness-pinned-model-"));
    try {
      const store = new InMemoryStore();
      const options = {
        store,
        home,
        defaults: { model: { provider: "fake", model: "first", preset: "high" } },
        plugins: [{ id: "fake", providers: () => [new FakeProvider([])] }],
      };
      const service = new HarnessService(options);
      const a = await service.createConversation();
      const b = await service.createConversation();
      await Promise.all([service.prepare(a.id), service.prepare(b.id)]);
      await service.setModel(a.id, { provider: "fake", model: "next" });
      expect((await service.getConversation(b.id))?.config.model).toEqual(options.defaults.model);
      expect((await service.createConversation()).config.model).toEqual({
        provider: "fake",
        model: "next",
      });
      await service.deactivateSession(b.id);
      await service.prepare(b.id);
      expect(service.conversationTreeState(b.id)[0]?.conversation.config.model).toEqual(
        options.defaults.model,
      );
      const resumed = new HarnessService(options);
      expect((await resumed.getConversation(b.id))?.config.model).toEqual(options.defaults.model);
      expect((await store.getConversation(b.id))?.overrides.model).toEqual(options.defaults.model);
      await Promise.all([service.deactivateSession(a.id), service.deactivateSession(b.id)]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent deep patches and sibling plugin slices", async () => {
    const service = new HarnessService({
      store: new InMemoryStore(),
      home: "/nonexistent-harness-home",
      defaults: { model: { provider: "fake", model: "first" } },
      plugins: [
        {
          id: "audit",
          configSchema: z.strictObject({ a: z.number().default(0), b: z.number().default(0) }),
          create: () => ({ id: "audit" }),
        },
        {
          id: "sibling",
          configSchema: z.strictObject({ enabled: z.boolean().default(false) }),
          create: () => ({ id: "sibling" }),
        },
      ],
    });
    const conversation = await service.createConversation();
    await Promise.all([
      service.setPluginConfig(conversation.id, "audit", { a: 1 }),
      service.setPluginConfig(conversation.id, "audit", { b: 2 }),
      service.setPluginConfig(conversation.id, "sibling", { enabled: true }),
    ]);
    expect((await service.getConversation(conversation.id))?.config.plugins).toEqual({
      audit: { a: 1, b: 2 },
      sibling: { enabled: true },
    });
  });

  it("inherits the parent model and only plugin-owned child configuration", async () => {
    const service = new HarnessService({
      store: new InMemoryStore(),
      home: "/nonexistent-harness-home",
      defaults: { model: { provider: "fake", model: "default" } },
      plugins: [
        {
          id: "execution-policy",
          inheritConfig: true,
          configSchema: z.strictObject({ backend: z.string().default("local") }),
          create: () => ({ id: "execution-policy" }),
        },
        {
          id: "approval",
          configSchema: z.strictObject({ enabled: z.boolean().default(true) }),
          create: () => ({ id: "approval" }),
        },
      ],
    });
    const parent = await service.createConversation({
      overrides: {
        model: { provider: "fake", model: "parent", preset: "high" },
        plugins: { "execution-policy": { backend: "docker" }, approval: { enabled: false } },
      },
    });
    await service.prepare(parent.id);
    const child = await service.createConversation({
      parentId: parent.id,
      overrides: { instructions: "child prompt" },
    });
    expect(child.config.model).toEqual(parent.config.model);
    expect(child.config.plugins).toEqual({
      "execution-policy": { backend: "docker" },
      approval: { enabled: true },
    });
    const explicit = await service.createConversation({
      parentId: parent.id,
      overrides: {
        model: { provider: "fake", model: "agent" },
        plugins: { "execution-policy": { backend: "native" } },
      },
    });
    expect(explicit.config.model).toEqual({ provider: "fake", model: "agent" });
    expect(explicit.config.plugins?.["execution-policy"]).toEqual({ backend: "native" });
    await service.deactivateSession(parent.id);
  });

  it("pins legacy records before first activation", async () => {
    const store = new InMemoryStore();
    const legacy = await store.createConversation({ workspaceRoot: null, overrides: {} });
    const service = new HarnessService({
      store,
      home: "/nonexistent-harness-home",
      defaults: { model: { provider: "fake", model: "current-default" } },
      plugins: [],
    });
    await service.prepare(legacy.id);
    expect((await store.getConversation(legacy.id))?.overrides.model).toEqual({
      provider: "fake",
      model: "current-default",
    });
    await service.deactivateSession(legacy.id);
  });
});
