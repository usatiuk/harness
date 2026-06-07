import { describe, expect, it } from "vitest";
import type { ConversationId, NewItem, Store, TurnId } from "@harness/protocol";

const sampleConfig = () => ({
  instructions: "be helpful",
  model: { provider: "fake", model: "fake-1" },
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
      const conv = await store.createConversation({ config: sampleConfig() });
      const turn = await store.createTurn(conv.id);
      const a = await store.appendItem(message(conv.id, turn.id, "hi"));
      const b = await store.appendItem(message(conv.id, turn.id, "yo"));
      expect([a.seq, b.seq]).toEqual([0, 1]);
      const items = await store.listItems(conv.id);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });

    it("listItems honors a seq range", async () => {
      const store = makeStore();
      const conv = await store.createConversation({ config: sampleConfig() });
      const turn = await store.createTurn(conv.id);
      await store.appendItem(message(conv.id, turn.id, "a"));
      await store.appendItem(message(conv.id, turn.id, "b"));
      await store.appendItem(message(conv.id, turn.id, "c"));
      const mid = await store.listItems(conv.id, { fromSeq: 1, toSeq: 1 });
      expect(mid.map((i) => i.seq)).toEqual([1]);
    });

    it("tracks at most one running turn", async () => {
      const store = makeStore();
      const conv = await store.createConversation({ config: sampleConfig() });
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
      const conv = await store.createConversation({ config: sampleConfig() });
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

    it("namespaces plugin state by plugin + conversation + key", async () => {
      const store = makeStore();
      const conv = await store.createConversation({ config: sampleConfig() });
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
