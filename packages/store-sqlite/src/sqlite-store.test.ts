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

  it("migrates v2 → v3: reshapes conversations, wipes old conversation data", async () => {
    const path = tempDb();
    // Hand-build an OLD-shape (v2) database: `conversations` carries a resolved-`config` blob (no
    // workspace_root/overrides), with one conversation, at user_version = 2.
    const raw = new BetterSqlite3(path);
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      CREATE TABLE conversations ( id TEXT PRIMARY KEY, config TEXT NOT NULL, head TEXT REFERENCES items(id), created_at INTEGER NOT NULL );
      CREATE TABLE turns ( id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, created_at INTEGER NOT NULL );
      CREATE TABLE items ( id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id), parent TEXT REFERENCES items(id), type TEXT NOT NULL, call_id TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL );
      CREATE TABLE provider_payloads ( item_id TEXT PRIMARY KEY REFERENCES items(id), provider TEXT, model TEXT, type TEXT, version INTEGER, payload TEXT );
      CREATE TABLE plugin_state ( plugin TEXT, conversation_id TEXT REFERENCES conversations(id), key TEXT, value TEXT, PRIMARY KEY (plugin, conversation_id, key) );
      CREATE TABLE context_builds ( id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), created_at INTEGER, data TEXT );
      CREATE TABLE model_usage ( id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), turn_id TEXT REFERENCES turns(id), context_build_id TEXT REFERENCES context_builds(id), provider TEXT, model TEXT, usage TEXT, cost REAL, created_at INTEGER );
    `);
    raw.exec(
      `INSERT INTO conversations(id,config,head,created_at) VALUES ('c1','{"model":{"provider":"x","model":"y"}}',NULL,1)`,
    );
    // Child rows referencing c1, so the wipe's child-table DELETEs run against real data.
    raw.exec(`INSERT INTO turns(id,conversation_id,status,created_at) VALUES ('t1','c1','completed',1)`); // prettier-ignore
    raw.exec(`INSERT INTO items(id,conversation_id,seq,turn_id,parent,type,call_id,created_at,body) VALUES ('i1','c1',0,'t1',NULL,'message',NULL,1,'{}')`); // prettier-ignore
    raw.pragma("user_version = 2");
    raw.close();

    // Opening with the current store applies the v2 → v3 migration.
    const store = new SqliteStore(path);
    // Old conversation data is wiped (the user chose reset over backfill)...
    expect(await store.getConversation("c1" as ConversationId)).toBeUndefined();
    expect(await store.listConversations()).toEqual([]);
    // ...and the new record shape (workspace_root + overrides) round-trips, with FKs still enforced.
    const conv = await store.createConversation(
      newConversationInput({
        workspaceRoot: "/w",
        instructions: "be helpful",
        model: { provider: "fake", model: "fake-1" },
      }),
    );
    const reread = await store.getConversation(conv.id);
    expect(reread?.workspaceRoot).toBe("/w");
    expect(reread?.overrides).toEqual({
      instructions: "be helpful",
      model: { provider: "fake", model: "fake-1" },
    });
    const turn = await store.createTurn(conv.id);
    expect(turn.conversationId).toBe(conv.id);
    store.close();

    // The old child rows were actually deleted, and the migration advanced the version to 3.
    const check = new BetterSqlite3(path);
    expect((check.prepare("SELECT COUNT(*) AS n FROM turns WHERE id='t1'").get() as { n: number }).n).toBe(0); // prettier-ignore
    expect((check.prepare("SELECT COUNT(*) AS n FROM items WHERE id='i1'").get() as { n: number }).n).toBe(0); // prettier-ignore
    expect(check.pragma("user_version", { simple: true })).toBe(3);
    check.close();
  });
});
