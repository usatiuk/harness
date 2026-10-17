import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@harness/store";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import {
  HarnessClient,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
} from "@harness/client";
import { unusedCodeEvaluator, FakeProvider, textStep } from "@harness/testkit";
import { isKernelEvent, type ModelRequest, type ModelProvider } from "@harness/protocol";
import { conversationTitlesPlugin } from "./index.ts";

const usage = { inputTokens: 9, outputTokens: 3, cachedReadTokens: 0 };
function fixture(
  output: string | Error = "Fix sidebar conversation naming",
  configuredModel = false,
  home = "/nonexistent-harness-home",
) {
  const store = new InMemoryStore();
  const requests: ModelRequest[] = [];
  let release!: () => void, markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const base = new FakeProvider([]);
  const provider: ModelProvider = {
    provider: "fake",
    capabilities: () => base.capabilities(),
    validateConfig: () => {},
    listModels: () => [
      { provider: "fake", model: "fake-1" },
      { provider: "fake", model: "namer" },
    ],
    async *stream(request, signal, context) {
      requests.push(request);
      expect(context.conversationId).toBeDefined();
      if (request.items.length === 0) {
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else {
            signal.addEventListener("abort", () => resolve(), { once: true });
            void gate.then(resolve);
          }
        });
        if (signal.aborted) return;
        if (output instanceof Error) throw output;
        yield* textStep(output, undefined, usage);
      } else yield* textStep("Main response completed", undefined, usage);
    },
  };
  const service = new HarnessService({
    codeEvaluator: unusedCodeEvaluator,
    store,
    home,
    defaults: {
      model: { provider: "fake", model: "fake-1" },
      instructions: "private workspace instructions",
      ...(configuredModel
        ? {
            plugins: {
              "conversation-titles": { model: { provider: "fake", model: "namer", preset: "low" } },
            },
          }
        : {}),
    },
    plugins: [{ id: "fake", providers: () => [provider] }, conversationTitlesPlugin],
  });
  return { service, store, requests, started, release };
}

describe("first-message titles", () => {
  it("publishes and persists an excerpt over RPC, then a title while the main turn completes independently", async () => {
    const f = fixture(undefined, true);
    const pair = createInProcessMessageConnectionPair();
    const host = new HarnessRpcHost(f.service);
    const rpc = new HarnessRpcSession({
      connection: pair.right,
      host,
      server: { name: "test", version: "1" },
    });
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "test", version: "1" },
    });
    const domain = new HarnessDomainClient(client);
    rpc.start();
    try {
      await client.start();
      const conversation = await domain.createConversation();
      await domain.prepare(conversation.id);
      const titles: string[] = [];
      domain.subscribe(conversation.id, (event) => {
        if (isKernelEvent(event) && event.type === "title.changed") titles.push(event.title);
      });
      await domain.send(conversation.id, "fix   sidebar\nconversation naming");
      await f.started;
      await f.service.whenIdle(conversation.id);
      expect((await f.service.getItems(conversation.id)).at(-1)).toMatchObject({
        role: "assistant",
      });
      await vi.waitFor(() => expect(titles).toEqual(["fix sidebar conversation naming"]));
      expect((await domain.getConversation(conversation.id))?.title).toBe(titles[0]);
      const titleRequest = f.requests.find((request) => request.items.length === 0)!;
      expect(titleRequest).toMatchObject({
        modelConfig: { provider: "fake", model: "namer", preset: "low" },
        prompt: "fix   sidebar\nconversation naming",
        maxOutputTokens: 128,
        toolChoice: "none",
      });
      expect(titleRequest.tools ?? []).toEqual([]);
      expect(JSON.stringify(titleRequest)).not.toContain("private workspace instructions");
      f.release();
      await vi.waitFor(() => expect(titles).toHaveLength(2));
      expect(titles[1]).toBe("Fix sidebar conversation naming");
      expect((await domain.listConversations())[0]?.title).toBe(titles[1]);
      const rows = await f.service.usage(conversation.id);
      expect(rows.map((row) => row.purpose).sort()).toEqual(["agent", "title"]);
      expect(rows.find((row) => row.purpose === "title")?.usage).toEqual(usage);
      expect((await f.service.usageSummary(conversation.id)).agentContext?.model).toBe("fake-1");
      expect(
        (await f.service.getItems(conversation.id)).filter((item) => item.type === "message"),
      ).toHaveLength(2);
    } finally {
      f.release();
      client.closeConnection();
      await host.shutdown();
      await rpc.shutdown();
    }
  });

  it.each(["", new Error("external provider failure")])(
    "keeps the excerpt on empty output or failure and never retries after reload/rewind",
    async (output) => {
      const f = fixture(output);
      const c = await f.service.createConversation();
      try {
        await f.service.send(c.id, "first message");
        await f.started;
        f.release();
        await f.service.whenIdle(c.id);
        await f.service.deactivateSession(c.id);
        expect((await f.service.getConversation(c.id))?.title).toBe("first message");
        await f.service.prepare(c.id);
        const first = (await f.service.getItems(c.id))[0]!;
        await f.service.rewind(c.id, first.id);
        await f.service.send(c.id, "second message");
        await f.service.whenIdle(c.id);
        expect(f.requests.filter((request) => request.items.length === 0)).toHaveLength(1);
        expect((await f.service.getConversation(c.id))?.title).toBe("first message");
        expect((await f.service.usage(c.id)).find((row) => row.purpose === "title")?.usage).toEqual(
          output instanceof Error ? null : usage,
        );
      } finally {
        f.release();
        await f.service.deactivateSession(c.id, { force: true });
      }
    },
  );

  it("retains the captured conversation model and respects an explicit title overwrite", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-title-model-"));
    const f = fixture(undefined, false, home);
    const c = await f.service.createConversation();
    try {
      await f.service.send(c.id, "first message");
      await f.started;
      await f.service.setModel(c.id, { provider: "fake", model: "namer" });
      expect(f.requests.find((r) => r.items.length === 0)?.modelConfig.model).toBe("fake-1");
      await f.store.updateConversationTitle(c.id, "My explicit name", "first message");
      f.release();
      await f.service.whenIdle(c.id);
      await f.service.deactivateSession(c.id);
      expect((await f.service.getConversation(c.id))?.title).toBe("My explicit name");
      expect((await f.service.usage(c.id)).find((row) => row.purpose === "title")?.model).toBe(
        "fake-1",
      );
    } finally {
      f.release();
      await f.service.deactivateSession(c.id, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not start naming when cancelled while saving the excerpt", async () => {
    const f = fixture();
    const c = await f.service.createConversation();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const write = f.store.updateConversationTitle.bind(f.store);
    vi.spyOn(f.store, "updateConversationTitle").mockImplementation(async (...args) => {
      entered();
      await gate;
      return write(...args);
    });
    try {
      await f.service.send(c.id, "first message");
      await saving;
      f.service.cancelSession(c.id);
      release();
      await f.service.whenIdle(c.id);
      await f.service.deactivateSession(c.id);
      expect((await f.service.getConversation(c.id))?.title).toBe("first message");
      expect(f.requests.filter((request) => request.items.length === 0)).toEqual([]);
    } finally {
      release();
      await f.service.deactivateSession(c.id, { force: true });
    }
  });

  it("cancels and drains naming on session close without blocking the main turn", async () => {
    const f = fixture();
    const c = await f.service.createConversation();
    await f.service.send(c.id, "first message");
    await f.started;
    await f.service.whenIdle(c.id);
    expect(await f.service.deactivateSession(c.id)).toEqual({ status: "deactivated" });
    expect((await f.service.getConversation(c.id))?.title).toBe("first message");
    expect((await f.service.usage(c.id)).find((row) => row.purpose === "title")?.usage).toBeNull();
  });

  it("closes safely when the first input is still being persisted", async () => {
    const f = fixture();
    const c = await f.service.createConversation();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append = f.store.appendItem.bind(f.store);
    vi.spyOn(f.store, "appendItem").mockImplementation(async (item) => {
      entered();
      await gate;
      return append(item);
    });
    try {
      await f.service.send(c.id, "first message");
      await saving;
      const closing = f.service.deactivateSession(c.id, { force: true });
      release();
      expect(await closing).toEqual({ status: "deactivated" });
      expect(f.service.conversationTreeState(c.id)).toEqual([]);
      expect(f.requests.filter((request) => request.items.length === 0)).toEqual([]);
    } finally {
      release();
      await f.service.deactivateSession(c.id, { force: true });
    }
  });

  it("fails the turn and releases the runtime when saving the excerpt fails", async () => {
    const f = fixture();
    const c = await f.service.createConversation();
    vi.spyOn(f.store, "updateConversationTitle").mockRejectedValue(new Error("write failed"));
    const statuses: string[] = [];
    f.service.subscribe(c.id, (event) => {
      if (isKernelEvent(event) && event.type === "turn.status") statuses.push(event.status);
    });
    await f.service.send(c.id, "first message");
    await f.service.whenIdle(c.id);
    expect(statuses).toEqual(["running", "failed"]);
    expect(await f.store.getActiveTurn(c.id)).toBeUndefined();
    expect(await f.service.deactivateSession(c.id)).toEqual({ status: "deactivated" });
    expect(f.service.conversationTreeState(c.id)).toEqual([]);
  });

  it("surfaces an internal persistence failure and still releases the runtime", async () => {
    const f = fixture();
    const c = await f.service.createConversation();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const write = f.store.recordModelUsage.bind(f.store);
    const fault = new TypeError("private persistence failure");
    vi.spyOn(f.store, "recordModelUsage").mockImplementation((row) => {
      if (row.purpose === "title") return Promise.reject(fault);
      return write(row);
    });
    try {
      await f.service.send(c.id, "first message");
      await f.started;
      f.release();
      await f.service.whenIdle(c.id);
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "conversation.title.failed",
          conversationId: c.id,
          kind: "TypeError",
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      await expect(f.service.deactivateSession(c.id)).rejects.toThrow(
        "conversation cleanup failed",
      );
      expect(f.service.conversationTreeState(c.id)).toEqual([]);
      expect((await f.service.getConversation(c.id))?.title).toBe("first message");
    } finally {
      f.release();
      log.mockRestore();
      await f.service.deactivateSession(c.id, { force: true });
    }
  });

  it("does not name subagent conversations", async () => {
    const f = fixture();
    const parent = await f.service.createConversation();
    await f.service.prepare(parent.id);
    const child = await f.service.createConversation({ parentId: parent.id });
    try {
      await f.service.send(child.id, "child task");
      await f.service.whenIdle(child.id);
      expect((await f.service.getConversation(child.id))?.title).toBeNull();
      expect(f.requests.filter((request) => request.items.length === 0)).toHaveLength(0);
    } finally {
      await f.service.deactivateSession(parent.id, { force: true });
    }
  });
});
