import { describe, expect, it } from "vitest";
import type { ConversationId, NewItem, Store, TurnId } from "@harness/protocol";
import { newConversationInput } from "./conversation.ts";

const sampleRecord = () =>
  newConversationInput({
    instructions: "be helpful",
    model: { provider: "fake", model: "fake-1" },
    plugins: { demo: { level: "high" } },
  });

const message = (conversationId: ConversationId, turnId: TurnId, text: string): NewItem => ({
  conversationId,
  turnId,
  type: "message",
  role: "user",
  content: [{ type: "text", text }],
});

/**
 * Behavioral spec every Store impl must satisfy. Run it against the in-memory
 * store now and the sqlite store later — this is the "in-memory ≡ sqlite" proof.
 */
export function storeContract(name: string, makeStore: () => Store): void {
  describe(name, () => {
    it("assigns monotonic per-conversation seq on append", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "hi"));
      const b = await store.appendItem(message(conv.id, turn.id, "yo"));
      expect([a.seq, b.seq]).toEqual([0, 1]);
      const items = await store.listItems(conv.id);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });

    it("listConversations returns every conversation, most-recent-first", async () => {
      const store = makeStore();
      const a = await store.createConversation(sampleRecord());
      const b = await store.createConversation(sampleRecord());
      const c = await store.createConversation(sampleRecord());
      expect((await store.listConversations()).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    });

    it("paginates conversations with an exclusive stable cursor", async () => {
      const store = makeStore();
      const a = await store.createConversation(sampleRecord());
      const b = await store.createConversation(sampleRecord());
      const c = await store.createConversation(sampleRecord());
      const first = await store.listConversationPage(2);
      expect(first.map((record) => record.id)).toEqual([c.id, b.id]);
      const second = await store.listConversationPage(2, {
        createdAt: b.createdAt,
        id: b.id,
      });
      expect(second.map((record) => record.id)).toEqual([a.id]);
    });

    it("updateConversationOverrides shallow-merges the patch and preserves the rest", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      await store.updateConversationOverrides(conv.id, {
        model: { provider: "fake", model: "fake-2" },
      });
      const updated = await store.getConversation(conv.id);
      expect(updated?.overrides.model).toEqual({ provider: "fake", model: "fake-2" });
      expect(updated?.overrides.instructions).toBe("be helpful");
      expect(updated?.overrides.plugins).toEqual({ demo: { level: "high" } });
    });

    it("updateConversationOverrides applies concurrent different-key patches without losing a write", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      // Both fire before either is awaited. A non-atomic read-modify-write would let the two patches
      // read the same base and the second clobber the first's key; an atomic merge keeps both.
      await Promise.all([
        store.updateConversationOverrides(conv.id, {
          model: { provider: "fake", model: "fake-2" },
        }),
        store.updateConversationOverrides(conv.id, { instructions: "be terse" }),
      ]);
      const updated = await store.getConversation(conv.id);
      expect(updated?.overrides.model).toEqual({ provider: "fake", model: "fake-2" });
      expect(updated?.overrides.instructions).toBe("be terse");
    });

    it("deleteConversationIfEmpty drops untouched conversations and spares used ones", async () => {
      const store = makeStore();
      const empty = await store.createConversation(sampleRecord());
      const used = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(used.id);
      await store.appendItem(message(used.id, turn.id, "hi"));

      // A conversation whose turn never appended (head still null) counts as in-use.
      const started = await store.createConversation(sampleRecord());
      await store.createTurn(started.id);

      await store.deleteConversationIfEmpty(empty.id);
      await store.deleteConversationIfEmpty(used.id);
      await store.deleteConversationIfEmpty(started.id);
      await store.deleteConversationIfEmpty("missing" as ConversationId); // no-op

      expect((await store.listConversations()).map((x) => x.id).sort()).toEqual(
        [used.id, started.id].sort(),
      );
    });

    it("links parent to the prior head and advances head on append", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      expect(conv.head).toBeNull();
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      expect(a.parent).toBeNull();
      expect(b.parent).toBe(a.id);
      expect((await store.getConversation(conv.id))?.head).toBe(b.id);
    });

    it("setHead moves head and listActiveItems follows the new lineage", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id, b.id]);
      await store.setHead(conv.id, a.id);
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id]);
    });

    it("setHead rejects an item from another conversation", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(other.id);
      const stray = await store.appendItem(message(other.id, turn.id, "x"));
      await expect(store.setHead(conv.id, stray.id)).rejects.toThrow();
    });

    it("branches: the abandoned tail is off the active chain but kept in the raw log", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const abandoned = await store.appendItem(message(conv.id, turn.id, "abandoned"));
      await store.setHead(conv.id, a.id);
      const branched = await store.appendItem(message(conv.id, turn.id, "branched"));

      // The new item branches off `a`, not the abandoned tail.
      expect(branched.parent).toBe(a.id);
      expect(branched.seq).toBeGreaterThan(abandoned.seq); // seq keeps growing across the branch
      // Active chain skips the abandoned item; the raw log retains all three.
      expect((await store.listActiveItems(conv.id)).map((i) => i.id)).toEqual([a.id, branched.id]);
      expect((await store.listItems(conv.id)).map((i) => i.id)).toEqual([
        a.id,
        abandoned.id,
        branched.id,
      ]);
    });

    it("reads an anchored lineage newest-first in bounded pages", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const other = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "a"));
      const b = await store.appendItem(message(conv.id, turn.id, "b"));
      const c = await store.appendItem(message(conv.id, turn.id, "c"));

      expect((await store.listItemAncestors(conv.id, c.id, 2)).map((item) => item.id)).toEqual([
        c.id,
        b.id,
      ]);
      expect((await store.listItemAncestors(conv.id, b.parent, 2)).map((item) => item.id)).toEqual([
        a.id,
      ]);
      expect(await store.getItem(conv.id, b.id)).toEqual(b);
      expect(await store.getItem(other.id, b.id)).toBeUndefined();
    });

    it("listItems honors a seq range", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      await store.appendItem(message(conv.id, turn.id, "a"));
      await store.appendItem(message(conv.id, turn.id, "b"));
      await store.appendItem(message(conv.id, turn.id, "c"));
      const mid = await store.listItems(conv.id, { fromSeq: 1, toSeq: 1 });
      expect(mid.map((i) => i.seq)).toEqual([1]);
    });

    it("round-trips a reasoning item", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "reasoning",
        content: [{ type: "text", text: "thinking" }],
      });
      const [stored] = await store.listItems(conv.id);
      expect(stored).toEqual(item);
      expect(stored?.type === "reasoning" && stored.content).toEqual([
        { type: "text", text: "thinking" },
      ]);
    });

    it("round-trips a context item, key intact, on the active chain", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "context",
        key: "agents-md:src/api/AGENTS.md",
        content: [{ type: "text", text: "project rules" }],
      });
      const [stored] = await store.listItems(conv.id);
      expect(stored).toEqual(item);
      expect(stored?.type === "context" && stored.key).toBe("agents-md:src/api/AGENTS.md");
      // it is on the active chain (the source the model build reads)
      expect(await store.listActiveItems(conv.id)).toEqual([item]);
    });

    it("round-trips namespaced tool-result annotations", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const item = await store.appendItem({
        conversationId: conv.id,
        turnId: turn.id,
        type: "tool_result",
        callId: "call-1",
        content: [{ type: "text", text: "ran" }],
        status: "ok",
        annotations: {
          approval: {
            decision: "allow",
            responder: "auto",
            relationship: "out-of-workspace",
          },
        },
      });
      expect((await store.listItems(conv.id))[0]).toEqual(item);
    });

    it("tracks at most one running turn", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      expect(await store.getActiveTurn(conv.id)).toEqual(turn);
      await expect(store.createTurn(conv.id)).rejects.toThrow();
      await store.updateTurn(turn.id, "completed");
      expect(await store.getActiveTurn(conv.id)).toBeUndefined();
      // a fresh turn is allowed once the previous one is no longer running
      await store.createTurn(conv.id);
    });

    it("round-trips provider payloads by itemId", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "x"));
      const b = await store.appendItem(message(conv.id, turn.id, "y"));
      const payload = {
        itemId: a.id,
        provider: "fake",
        model: "fake-1",
        type: "reasoning",
        version: 1,
        payload: { encrypted: "blob" },
      };
      await store.putProviderPayload(payload);
      expect(await store.getProviderPayloads([a.id])).toEqual([payload]);
      expect(await store.getProviderPayloads([b.id])).toEqual([]);
    });

    it("round-trips model usage rows in record order", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      const turn = await store.createTurn(conv.id);
      const build = await store.recordContextBuild({
        conversationId: conv.id,
        instructions: [],
        tools: [],
        items: [],
      });
      expect(await store.getContextBuild(build.id)).toEqual(build);
      expect(await store.getContextBuild("missing")).toBeUndefined();
      const first = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: build.id,
        provider: "fake",
        model: "fake-1",
        usage: {
          inputTokens: 1200,
          outputTokens: 80,
          cachedReadTokens: 1000,
          cacheWriteTokens: { 300: 100 },
        },
        cost: 0.0123,
      });
      const second = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: null,
        provider: "fake",
        model: "fake-2", // differs from the conversation's config: the row snapshots the model
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 },
        cost: null,
      });
      const unknown = await store.recordModelUsage({
        conversationId: conv.id,
        turnId: turn.id,
        contextBuildId: build.id,
        provider: "compatible",
        model: "usage-omitted",
        usage: null,
        cost: null,
      });
      expect(await store.listModelUsage(conv.id)).toEqual([first, second, unknown]);
      expect(await store.listModelUsage("missing" as ConversationId)).toEqual([]);
      expect(await store.summarizeModelUsage(conv.id)).toEqual({
        usage: {
          inputTokens: 1210,
          outputTokens: 85,
          cachedReadTokens: 1000,
          cacheWriteTokens: { 300: 100 },
        },
        incomplete: true,
        cost: 0.0123,
        lastInputTokens: 10,
      });
    });

    it("namespaces plugin state by plugin + conversation + key", async () => {
      const store = makeStore();
      const conv = await store.createConversation(sampleRecord());
      await store.putPluginState("p", conv.id, "k", { v: 1 });
      expect(await store.getPluginState("p", conv.id, "k")).toEqual({ v: 1 });
      expect(await store.getPluginState("p", conv.id, "other")).toBeUndefined();
      expect(await store.getPluginState("q", conv.id, "k")).toBeUndefined();
    });

    it("stores blobs and reads byte ranges", async () => {
      const store = makeStore();
      const ref = await store.putBlob(new TextEncoder().encode("hello world"));
      expect(ref.bytes).toBe(11);
      expect(new TextDecoder().decode(await store.getBlob(ref))).toBe("hello world");
      const part = await store.getBlob(ref, { offset: 0, length: 5 });
      expect(new TextDecoder().decode(part)).toBe("hello");
    });
  });
}
