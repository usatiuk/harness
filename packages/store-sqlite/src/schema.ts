import type BetterSqlite3 from "better-sqlite3";

/**
 * Kysely row types. JSON columns (`overrides`/`body`/`payload`/`value`) are TEXT;
 * `blobs.data` is a real BLOB. `items.call_id` is denormalized out of `body` so the
 * `tool_result` partial unique index needs no JSON expression. The types describe the
 * current schema, which is what every query sees.
 */
export interface Database {
  conversations: ConversationsTable;
  managed_worktrees: { path: string; repository: string; created_at: number };
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
  original_workspace_root: string | null;
  /** Durable settings-overrides layer, JSON. Config itself is resolved on load, never stored. */
  overrides: string;
  head: string | null;
  title: string | null;
  created_at: number;
  last_used_at: number;
  fork_origin: string | null;
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
  scope: string | null;
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
  purpose: string | null;
  request_duration_ms: number | null;
  usage: string;
  cost: number | null;
  provider_usage: string | null;
  cost_incomplete: number;
  input_tokens_are_context: number;
  created_at: number;
}

// Forward FK refs are legal in SQLite (checked at DML, not DDL), so the mutual
// conversations⇄items cycle needs no ordering or DEFERRABLE — the append order satisfies
// every FK (item before head advances; head starts NULL). The only delete
// (deleteConversationIfEmpty) targets rows nothing references, so plain REFERENCES still holds.
const WORKTREE_SCHEMA = `CREATE TABLE managed_worktrees (
  path TEXT PRIMARY KEY, repository TEXT NOT NULL, created_at INTEGER NOT NULL
);`;

const QUESTIONS_SCHEMA = `CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  body TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0, 1)),
  delivery_pending INTEGER NOT NULL DEFAULT 0 CHECK(delivery_pending IN (0, 1))
);
CREATE INDEX questions_pending ON questions(conversation_id) WHERE pending = 1;
`;
const SCHEMA = `
${WORKTREE_SCHEMA}
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_root TEXT,
  original_workspace_root TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  head TEXT REFERENCES items(id),
  title TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  fork_origin TEXT
);
CREATE INDEX conversations_recent ON conversations(last_used_at DESC, id DESC);
CREATE INDEX conversations_workspace_recent ON conversations(workspace_root, last_used_at DESC, id DESC);
CREATE INDEX conversations_project_recent ON conversations(coalesce(original_workspace_root, workspace_root), last_used_at DESC, id DESC);

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
  scope TEXT,
  PRIMARY KEY (plugin, conversation_id, key)
);

CREATE INDEX plugin_state_scope ON plugin_state(plugin, key, scope, conversation_id);
CREATE INDEX turns_latest ON turns(conversation_id);

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

CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  context_build_id TEXT REFERENCES context_builds(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT,
  request_duration_ms REAL CHECK(request_duration_ms >= 0),
  usage TEXT NOT NULL,
  cost REAL,
  provider_usage TEXT,
  cost_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(cost_incomplete IN (0, 1)),
  input_tokens_are_context INTEGER NOT NULL DEFAULT 1 CHECK(input_tokens_are_context IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX model_usage_conv ON model_usage(conversation_id);
CREATE INDEX model_usage_agent ON model_usage(conversation_id, created_at DESC) WHERE purpose = 'agent';
CREATE INDEX model_usage_turn ON model_usage(turn_id);
CREATE INDEX turns_terminal ON turns(conversation_id, created_at DESC) WHERE status <> 'running';
`;

export const STORE_SCHEMA_VERSION = 13;

/** Fresh schema or supported additive upgrades; older formats remain unsupported. */
export function initializeSchema(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    let version = db.pragma("user_version", { simple: true }) as number;
    if (version === STORE_SCHEMA_VERSION) return;
    if (version === 3) {
      db.exec(`ALTER TABLE model_usage ADD COLUMN purpose TEXT;
        ALTER TABLE model_usage ADD COLUMN request_duration_ms REAL CHECK(request_duration_ms >= 0);
        CREATE INDEX model_usage_agent ON model_usage(conversation_id, created_at DESC) WHERE purpose = 'agent';
        CREATE INDEX model_usage_turn ON model_usage(turn_id);
        CREATE INDEX turns_terminal ON turns(conversation_id, created_at DESC) WHERE status <> 'running';`);
      version = 4;
    }
    if (version === 4) {
      db.exec(`ALTER TABLE model_usage ADD COLUMN provider_usage TEXT;
        ALTER TABLE model_usage ADD COLUMN cost_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(cost_incomplete IN (0, 1));`);
      version = 5;
    }
    if (version === 5) {
      db.exec(
        `ALTER TABLE model_usage ADD COLUMN input_tokens_are_context INTEGER NOT NULL DEFAULT 1 CHECK(input_tokens_are_context IN (0, 1));`,
      );
      // Older rows did not classify cumulative billing input. Keep their spend,
      // but do not infer a trustworthy prompt-size checkpoint from it.
      db.exec("UPDATE model_usage SET input_tokens_are_context = 0;");
      version = 6;
    }
    if (version === 6) {
      db.exec("ALTER TABLE conversations ADD COLUMN title TEXT;");
      version = 7;
    }
    if (version === 7) {
      db.exec(`ALTER TABLE conversations ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
        UPDATE conversations SET last_used_at = created_at;
        CREATE INDEX conversations_recent ON conversations(last_used_at DESC, id DESC);
        CREATE INDEX conversations_workspace_recent ON conversations(workspace_root, last_used_at DESC, id DESC);`);
      version = 8;
    }
    if (version === 8) {
      db.exec("ALTER TABLE conversations ADD COLUMN fork_origin TEXT;");
      version = 9;
    }
    if (version === 9) {
      db.exec("ALTER TABLE conversations ADD COLUMN original_workspace_root TEXT;");
      db.exec(WORKTREE_SCHEMA);
      version = 10;
    }
    if (version === 10) {
      db.exec(
        "CREATE INDEX conversations_project_recent ON conversations(coalesce(original_workspace_root, workspace_root), last_used_at DESC, id DESC)",
      );
      version = 11;
    }
    if (version === 11) {
      db.exec(`ALTER TABLE plugin_state ADD COLUMN scope TEXT;
        CREATE INDEX plugin_state_scope ON plugin_state(plugin, key, scope, conversation_id);
        CREATE INDEX turns_latest ON turns(conversation_id);
        UPDATE plugin_state SET scope = json_extract(value, '$.parent.conversationId')
          WHERE plugin = 'subagents' AND key = 'spawn';`);
      version = 12;
    }
    if (version === 12) {
      db.exec(QUESTIONS_SCHEMA);
      db.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
      return;
    }
    const populated = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get();
    if (version !== 0 || populated)
      throw new Error(
        `Unsupported Harness database format (${version}) in ${db.name}; this server supports version ${STORE_SCHEMA_VERSION}. Upgrade Harness to a compatible server. The database was not changed.`,
      );
    db.exec(SCHEMA);
    db.exec(QUESTIONS_SCHEMA);
    db.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
  }).exclusive();
}
