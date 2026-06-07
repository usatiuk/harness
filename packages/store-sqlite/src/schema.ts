import type BetterSqlite3 from "better-sqlite3";

/**
 * Kysely row types. JSON columns (`config`/`body`/`payload`/`value`) are TEXT;
 * `blobs.data` is a real BLOB. `items.call_id` is denormalized out of `body` so the
 * `tool_result` partial unique index needs no JSON expression.
 */
export interface Database {
  conversations: ConversationsTable;
  turns: TurnsTable;
  items: ItemsTable;
  provider_payloads: ProviderPayloadsTable;
  plugin_state: PluginStateTable;
  blobs: BlobsTable;
  context_builds: ContextBuildsTable;
}

interface ConversationsTable {
  id: string;
  config: string;
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

// Forward FK refs are legal in SQLite (checked at DML, not DDL), so the mutual
// conversations⇄items cycle needs no ordering or DEFERRABLE — the append order satisfies
// every FK (item before head advances; head starts NULL). No deletes ⇒ plain REFERENCES.
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

/** Idempotent bootstrap: creates the schema once, gated on `user_version`. */
export function migrate(db: BetterSqlite3.Database): void {
  if (db.pragma("user_version", { simple: true }) !== 0) return;
  db.exec(SCHEMA);
  db.pragma("user_version = 1");
}
