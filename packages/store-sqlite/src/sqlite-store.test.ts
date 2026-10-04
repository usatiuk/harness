import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, NewItem, TurnId } from "@harness/protocol";
import { counterIdGenerator, fixedClock, newConversationInput } from "@harness/testkit";
import { storeContract } from "@harness/testkit/contract";
import { SqliteStore } from "./sqlite-store.ts";

// The shared contract suite — same one that proves InMemoryStore (in-memory ≡ sqlite).
storeContract("SqliteStore", () => new SqliteStore(":memory:", counterIdGenerator(), fixedClock()));

const record = () =>
  newConversationInput({
    instructions: "be helpful",
    model: { provider: "fake", model: "fake-1" },
  });

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
    const conv = await store.createConversation(record());
    const turn = await store.createTurn(conv.id);
    await store.appendItem(toolResult(conv.id, turn.id, "call-1"));
    await expect(store.appendItem(toolResult(conv.id, turn.id, "call-1"))).rejects.toThrow();
  });

  it("persists items across a reopen", async () => {
    const path = tempDb();
    const first = new SqliteStore(path);
    const conv = await first.createConversation(record());
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

  it.each([0, 2, 999])(
    "rejects an unsupported database format %i without rewriting it",
    (version) => {
      const path = tempDb();
      const raw = new BetterSqlite3(path);
      raw.exec("CREATE TABLE obsolete (value INTEGER); INSERT INTO obsolete VALUES (42)");
      raw.pragma(`user_version = ${version}`);
      raw.close();
      expect(() => new SqliteStore(path)).toThrow("database migrations are not supported");
      const check = new BetterSqlite3(path);
      try {
        expect(check.pragma("user_version", { simple: true })).toBe(version);
        expect(check.prepare("SELECT value FROM obsolete").get()).toEqual({ value: 42 });
      } finally {
        check.close();
      }
    },
  );
  it("upgrades the previous schema additively and preserves history and unknown request timing", async () => {
    const path = tempDb();
    const before = new SqliteStore(path);
    const conv = await before.createConversation(record());
    const turn = await before.createTurn(conv.id);
    const item = await before.appendItem({
      conversationId: conv.id,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "preserved" }],
    });
    await before.recordModelUsage({
      conversationId: conv.id,
      turnId: turn.id,
      contextBuildId: null,
      provider: "fake",
      model: "fake-1",
      usage: { inputTokens: 8, outputTokens: 2, cachedReadTokens: 0 },
      cost: null,
    });
    await before.updateTurn(turn.id, "completed");
    before.close();
    const previous = new BetterSqlite3(path);
    previous.exec(
      "DROP INDEX model_usage_agent; DROP INDEX model_usage_turn; DROP INDEX turns_terminal; ALTER TABLE model_usage DROP COLUMN purpose; ALTER TABLE model_usage DROP COLUMN request_duration_ms;",
    );
    previous.pragma("user_version = 3");
    previous.close();
    const after = new SqliteStore(path);
    try {
      expect(await after.listItems(conv.id)).toEqual([item]);
      expect((await after.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
        turnId: turn.id,
        usage: { inputTokens: 8, outputTokens: 2 },
        agentOutputTokens: null,
        agentDurationMs: null,
      });
      expect((await after.listModelUsage(conv.id))[0]).not.toHaveProperty("requestDurationMs");
    } finally {
      after.close();
    }
  });
});
