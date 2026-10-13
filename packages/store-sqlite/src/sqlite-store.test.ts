import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

  it("persists a shared fork and upgrades schema 8 without copying history", async () => {
    const path = tempDb();
    const first = new SqliteStore(path);
    const source = await first.createConversation(record());
    const turn = await first.createTurn(source.id);
    const prefix = await first.appendItem({
      conversationId: source.id,
      turnId: turn.id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "prefix" }],
    });
    const user = await first.appendItem({
      conversationId: source.id,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "edit me" }],
    });
    first.close();
    const db = new BetterSqlite3(path);
    db.exec("ALTER TABLE conversations DROP COLUMN fork_origin; PRAGMA user_version = 8");
    db.close();
    const upgraded = new SqliteStore(path);
    const fork = await upgraded.forkConversation(source.id, user.id, {});
    upgraded.close();
    const reopened = new SqliteStore(path);
    try {
      expect((await reopened.getConversation(fork.id))?.fork).toEqual({
        conversationId: source.id,
        userMessageId: user.id,
      });
      expect(await reopened.listActiveItems(fork.id)).toEqual([prefix]);
      expect(await reopened.listOwnedItems(fork.id)).toEqual([]);
      expect(await reopened.listActiveItems(source.id)).toEqual([prefix, user]);
    } finally {
      reopened.close();
    }
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
    const items = await reopened.listOwnedItems(conv.id);
    expect(items).toEqual([item]);
    reopened.close();
  });

  it("upgrades v7 recency from creation time and preserves it and titles across restart", async () => {
    const path = tempDb();
    const before = new SqliteStore(path, counterIdGenerator(), fixedClock(100));
    const conversation = await before.createConversation(record());
    await before.updateConversationTitle(conversation.id, "Existing title", null);
    before.close();
    const previous = new BetterSqlite3(path);
    previous.exec(
      "DROP INDEX conversations_recent; DROP INDEX conversations_workspace_recent; ALTER TABLE conversations DROP COLUMN last_used_at; ALTER TABLE conversations DROP COLUMN fork_origin;",
    );
    previous.pragma("user_version = 7");
    previous.close();
    const upgraded = new SqliteStore(path, counterIdGenerator(), fixedClock(200));
    expect(await upgraded.getConversation(conversation.id)).toMatchObject({
      title: "Existing title",
      lastUsedAt: conversation.createdAt,
    });
    const timestamp = upgraded.recordUserInput(conversation.id);
    upgraded.close();
    const restarted = new SqliteStore(path);
    try {
      expect(await restarted.getConversation(conversation.id)).toMatchObject({
        title: "Existing title",
        lastUsedAt: timestamp,
      });
    } finally {
      restarted.close();
    }
  });

  it("paginates tied folder paths in SQLite binary order", async () => {
    const store = new SqliteStore(":memory:", counterIdGenerator(), { now: () => 1 });
    try {
      for (const workspaceRoot of ["/a", "/_a", "/A", "/\ue000", "/😀"])
        await store.createConversation({ ...record(), workspaceRoot });
      const seen: string[] = [];
      let cursor: { workspaceRoot: string; lastUsedAt: number } | undefined;
      do {
        const page = await store.listConversationProjects(1, cursor);
        if (!page.length) break;
        seen.push(page[0]!.workspaceRoot);
        cursor = page[0];
      } while (cursor !== undefined);
      expect(seen).toEqual(
        ["/a", "/_a", "/A", "/\ue000", "/😀"].sort((a, b) =>
          Buffer.compare(Buffer.from(b), Buffer.from(a)),
        ),
      );
    } finally {
      store.close();
    }
  });

  it.each([0, 2, 999])(
    "rejects an unsupported database format %i without rewriting it",
    (version) => {
      const path = tempDb();
      const raw = new BetterSqlite3(path);
      raw.exec("CREATE TABLE obsolete (value INTEGER); INSERT INTO obsolete VALUES (42)");
      raw.pragma(`user_version = ${version}`);
      raw.close();
      const original = readFileSync(path);
      expect(() => new SqliteStore(path, undefined, undefined, { exclusive: true })).toThrow(
        "Upgrade Harness to a compatible server",
      );
      expect(readFileSync(path)).toEqual(original);
      const check = new BetterSqlite3(path);
      try {
        expect(check.pragma("user_version", { simple: true })).toBe(version);
        expect(check.prepare("SELECT value FROM obsolete").get()).toEqual({ value: 42 });
      } finally {
        check.close();
      }
    },
  );
  it("holds SQLite exclusion before admission and leaves a rejected database unchanged", () => {
    const path = tempDb();
    const raw = new BetterSqlite3(path);
    raw.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('untouched')");
    raw.pragma("user_version = 3");
    raw.close();
    const original = readFileSync(path);
    const rejection = new Error("Selected server changed");
    expect(
      () =>
        new SqliteStore(path, undefined, undefined, {
          exclusive: true,
          beforeInitialize: () => {
            const rival = new BetterSqlite3(path);
            try {
              rival.pragma("busy_timeout = 0");
              expect(() => rival.prepare("SELECT value FROM preserved").get()).toThrow(
                "database is locked",
              );
            } finally {
              rival.close();
            }
            throw rejection;
          },
        }),
    ).toThrow(rejection);
    expect(readFileSync(path)).toEqual(original);
    // Rejection released the ownership lock without running the v3 migration.
    const reopened = new BetterSqlite3(path);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(3);
      expect(reopened.prepare("SELECT value FROM preserved").get()).toEqual({ value: "untouched" });
    } finally {
      reopened.close();
    }
  });
  it.each([3, 5, 6])(
    "upgrades schema v%s additively and preserves history with unknown context input",
    async (version) => {
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
        version === 3
          ? "DROP INDEX model_usage_agent; DROP INDEX model_usage_turn; DROP INDEX turns_terminal; ALTER TABLE model_usage DROP COLUMN purpose; ALTER TABLE model_usage DROP COLUMN request_duration_ms; ALTER TABLE model_usage DROP COLUMN provider_usage; ALTER TABLE model_usage DROP COLUMN cost_incomplete; ALTER TABLE model_usage DROP COLUMN input_tokens_are_context;"
          : version === 5
            ? "ALTER TABLE model_usage DROP COLUMN input_tokens_are_context;"
            : "SELECT 1;",
      );
      previous.exec(
        "DROP INDEX conversations_recent; DROP INDEX conversations_workspace_recent; ALTER TABLE conversations DROP COLUMN last_used_at; ALTER TABLE conversations DROP COLUMN title; ALTER TABLE conversations DROP COLUMN fork_origin;",
      );
      previous.pragma(`user_version = ${version}`);
      previous.close();
      const after = new SqliteStore(path);
      try {
        expect(await after.listOwnedItems(conv.id)).toEqual([item]);
        expect((await after.getConversation(conv.id))?.title).toBeNull();
        await after.updateConversationTitle(conv.id, "Saved title", null);
        expect((await after.summarizeModelUsage(conv.id)).lastTurn).toMatchObject({
          turnId: turn.id,
          usage: { inputTokens: 8, outputTokens: 2 },
          agentOutputTokens: null,
          agentDurationMs: null,
        });
        expect((await after.listModelUsage(conv.id))[0]).not.toHaveProperty("requestDurationMs");
        expect((await after.listModelUsage(conv.id))[0]?.inputTokensAreContext ?? true).toBe(
          version >= 6,
        );
        expect((await after.listModelUsage(conv.id))[0]).toMatchObject({
          usage: { inputTokens: 8, outputTokens: 2, cachedReadTokens: 0 },
        });
      } finally {
        after.close();
      }
      const reopened = new SqliteStore(path);
      try {
        expect((await reopened.getConversation(conv.id))?.title).toBe("Saved title");
        expect(await reopened.listOwnedItems(conv.id)).toEqual([item]);
      } finally {
        reopened.close();
      }
    },
  );
});
