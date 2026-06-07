import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, NewItem, TurnId } from "@harness/protocol";
import { counterIdGenerator, fixedClock } from "@harness/testkit";
import { storeContract } from "@harness/testkit/contract";
import { SqliteStore } from "./sqlite-store.ts";

// The shared contract suite — same one that proves InMemoryStore (in-memory ≡ sqlite).
storeContract("SqliteStore", () => new SqliteStore(":memory:", counterIdGenerator(), fixedClock()));

const config = () => ({ instructions: "be helpful", model: { provider: "fake", model: "fake-1" } });

const toolResult = (conversationId: ConversationId, turnId: TurnId, callId: string): NewItem => ({
  conversationId,
  turnId,
  type: "tool_result",
  callId,
  content: [{ type: "text", text: "out" }],
  status: "ok",
});

// Durable-only invariants: cross-process atomicity and on-disk persistence.
describe("SqliteStore (durable-only)", () => {
  const dirs: string[] = [];
  const tempDb = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sqlite-"));
    dirs.push(dir);
    return join(dir, "store.db");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a duplicate tool_result for the same callId (partial unique index)", async () => {
    const store = new SqliteStore(":memory:", counterIdGenerator(), fixedClock());
    const conv = await store.createConversation({ config: config() });
    const turn = await store.createTurn(conv.id);
    await store.appendItem(toolResult(conv.id, turn.id, "call-1"));
    await expect(store.appendItem(toolResult(conv.id, turn.id, "call-1"))).rejects.toThrow();
  });

  it("persists items across a reopen", async () => {
    const path = tempDb();
    const first = new SqliteStore(path);
    const conv = await first.createConversation({ config: config() });
    const turn = await first.createTurn(conv.id);
    const item = await first.appendItem({
      conversationId: conv.id,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "survives restart" }],
    });
    first.close();

    const reopened = new SqliteStore(path);
    const items = await reopened.listItems(conv.id);
    expect(items).toEqual([item]);
    reopened.close();
  });
});
