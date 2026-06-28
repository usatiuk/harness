import type BetterSqlite3 from "better-sqlite3";

/**
 * Kysely row types. JSON columns (`overrides`/`body`/`payload`/`value`) are TEXT;
 * `blobs.data` is a real BLOB. `items.call_id` is denormalized out of `body` so the
 * `tool_result` partial unique index needs no JSON expression. The types describe the
 * CURRENT (post-migration) schema, which is what every query sees.
 */
export interface Database {
  conversations: ConversationsTable;
  turns: TurnsTable;
  items: ItemsTable;
  provider_payloads: ProviderPayloadsTable;
  plugin_state: PluginStateTable;
  blobs: BlobsTable;
  context_builds: ContextBuildsTable;
  model_usage: ModelUsageTable;
}

interface ConversationsTable {
  id: string;
  /** The execution workspace root; NULL when projectless. */
  workspace_root: string | null;
  /** Durable settings-overrides layer, JSON. Config itself is resolved on load, never stored. */
  overrides: string;
  head: string | null;
  created_at: number;
}

interface TurnsTable {
  id: string;
  conversation_id: string;
  status: string;
  created_at: number;
}

interface ItemsTable {
  id: string;
  conversation_id: string;
  seq: number;
  turn_id: string;
  parent: string | null;
  type: string;
  call_id: string | null;
  created_at: number;
  body: string;
}

interface ProviderPayloadsTable {
  item_id: string;
  provider: string;
  model: string;
  type: string;
  version: number;
  payload: string;
}

interface PluginStateTable {
  plugin: string;
  conversation_id: string;
  key: string;
  value: string;
}

interface BlobsTable {
  id: string;
  content_type: string;
  data: Uint8Array;
}

interface ContextBuildsTable {
  id: string;
  conversation_id: string;
  created_at: number;
  data: string;
}

interface ModelUsageTable {
  id: string;
  conversation_id: string;
  turn_id: string;
  context_build_id: string | null;
  provider: string;
  model: string;
  usage: string;
  cost: number | null;
  created_at: number;
}

// Forward FK refs are legal in SQLite (checked at DML, not DDL), so the mutual
// conversations⇄items cycle needs no ordering or DEFERRABLE — the append order satisfies
// every FK (item before head advances; head starts NULL). The only delete
// (deleteConversationIfEmpty) targets rows nothing references, so plain REFERENCES still holds.
const SCHEMA = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  head TEXT REFERENCES items(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX turns_one_running ON turns(conversation_id) WHERE status = 'running';

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  parent TEXT REFERENCES items(id),
  type TEXT NOT NULL,
  call_id TEXT,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE UNIQUE INDEX items_conv_seq ON items(conversation_id, seq);
CREATE UNIQUE INDEX items_tool_result_call
  ON items(conversation_id, call_id) WHERE type = 'tool_result';

CREATE TABLE provider_payloads (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE plugin_state (
  plugin TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin, conversation_id, key)
);

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL
);

CREATE TABLE context_builds (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
`;

const MODEL_USAGE = `
CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  context_build_id TEXT REFERENCES context_builds(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  usage TEXT NOT NULL,
  cost REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX model_usage_conv ON model_usage(conversation_id);
`;

// v2 → v3: store `workspace_root` (identity) + an `overrides` layer; config is re-resolved from the
// cascade on load. The store is disposable, so conversation-scoped data is WIPED, not backfilled from
// old `config` blobs (reset chosen over migration). FKs are toggled off for the conversations
// drop/recreate so no delete-ordering is needed, then restored — the connection retains the pragma
// and the schema relies on FK enforcement.
const CONVERSATIONS_OVERRIDES = `
PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS conversations;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_root TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  head TEXT REFERENCES items(id),
  created_at INTEGER NOT NULL
);
DELETE FROM items;
DELETE FROM turns;
DELETE FROM provider_payloads;
DELETE FROM plugin_state;
DELETE FROM context_builds;
DELETE FROM model_usage;
PRAGMA foreign_keys = ON;
`;

// Index i migrates user_version i → i+1; a fresh DB replays the whole list. Historical entries are
// immutable (existing DBs already ran them); shape changes are appended, never edited.
const MIGRATIONS = [SCHEMA, MODEL_USAGE, CONVERSATIONS_OVERRIDES];

/** Idempotent bootstrap: applies pending migrations, gated on `user_version`. */
export function migrate(db: BetterSqlite3.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  for (const [i, migration] of MIGRATIONS.entries()) {
    if (i < version) continue;
    db.exec(migration);
    db.pragma(`user_version = ${i + 1}`);
  }
}
