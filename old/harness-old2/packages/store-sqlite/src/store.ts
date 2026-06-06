import Database from "better-sqlite3";
import {
  agentRunRecordSchema,
  contextBuildSchema,
  contextProjectionSchema,
  conversationItemSchema,
  conversationRecordSchema,
  profileRecordSchema,
  providerStateSchema,
  type AgentRunRecord,
  type AgentRunStatus,
  type ConversationItem,
  type ConversationItemClass,
  type ConversationItemKind,
  type ConversationItemVisibility,
  type ConversationRecord,
  type ContentBlock,
  type ContextBuild,
  type ContextProjection,
  type JsonValue,
  type MessageRole,
  type ModelConfig,
  type ProfileConfig,
  type ProfileRecord,
  type ProviderState,
  type SourceRef
} from "@harness/protocol";
import { createId, nowIso, type HarnessStore } from "@harness/core";

export interface SqliteHarnessStoreOptions {
  path: string;
}

export function openSqliteHarnessStore(options: SqliteHarnessStoreOptions): SqliteHarnessStore {
  return new SqliteHarnessStore(options);
}

export class SqliteHarnessStore implements HarnessStore {
  private readonly db: Database.Database;

  public constructor(options: SqliteHarnessStoreOptions) {
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public async createProfile(input: { id?: string; name: string; config: ProfileConfig }): Promise<ProfileRecord> {
    const id = input.id ?? createId("prof");
    const timestamp = nowIso();
    this.db.prepare("insert into profiles (id, name, config_json, created_at, updated_at) values (?, ?, ?, ?, ?)").run(id, input.name, encode(input.config), timestamp, timestamp);
    return profileRecordSchema.parse(rowToProfile(this.one("select * from profiles where id = ?", [id])));
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    return this.all("select * from profiles order by name asc").map((row) => profileRecordSchema.parse(rowToProfile(row)));
  }

  public async getProfileByName(name: string): Promise<ProfileRecord | undefined> {
    const row = this.oneOptional("select * from profiles where name = ?", [name]);
    return row ? profileRecordSchema.parse(rowToProfile(row)) : undefined;
  }

  public async setDefaultProfileName(name: string): Promise<void> {
    this.db.prepare("insert into settings (key, value) values ('default_profile_name', ?) on conflict(key) do update set value = excluded.value").run(name);
  }

  public async getDefaultProfileName(): Promise<string | undefined> {
    const row = this.oneOptional("select value from settings where key = 'default_profile_name'");
    return row && typeof row.value === "string" ? row.value : undefined;
  }

  public async createConversation(input: { id?: string; profileName?: string; config: ProfileConfig; title?: string }): Promise<ConversationRecord> {
    const id = input.id ?? createId("conv");
    const timestamp = nowIso();
    this.db.prepare("insert into conversations (id, profile_name, config_json, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      input.profileName ?? null,
      encode(input.config),
      input.title ?? null,
      "created",
      timestamp,
      timestamp
    );
    return conversationRecordSchema.parse(rowToConversation(this.one("select * from conversations where id = ?", [id])));
  }

  public async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const row = this.oneOptional("select * from conversations where id = ?", [id]);
    return row ? conversationRecordSchema.parse(rowToConversation(row)) : undefined;
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return this.all("select * from conversations order by created_at asc").map((row) => conversationRecordSchema.parse(rowToConversation(row)));
  }

  public async updateConversation(input: { id: string; status?: ConversationRecord["status"]; title?: string }): Promise<ConversationRecord> {
    const current = await this.getConversation(input.id);
    if (!current) {
      throw new Error(`Conversation ${input.id} not found`);
    }
    this.db.prepare("update conversations set status = ?, title = ?, updated_at = ? where id = ?").run(input.status ?? current.status, input.title ?? current.title ?? null, nowIso(), input.id);
    return conversationRecordSchema.parse(rowToConversation(this.one("select * from conversations where id = ?", [input.id])));
  }

  public async appendConversationItem(input: {
    id?: string;
    conversationId: string;
    class: ConversationItemClass;
    kind: ConversationItemKind;
    role?: MessageRole;
    visibility: ConversationItemVisibility;
    runId?: string;
    source?: SourceRef;
    content: ContentBlock[];
    data?: JsonValue;
  }): Promise<ConversationItem> {
    const id = input.id ?? createId("item");
    const timestamp = nowIso();
    const sequence = this.transaction(() => {
      const next = Number(this.one("select coalesce(max(sequence), 0) + 1 as sequence from conversation_items where conversation_id = ?", [input.conversationId]).sequence);
      this.db.prepare(
        "insert into conversation_items (id, conversation_id, sequence, item_class, kind, role, visibility, run_id, source_type, source_id, content_json, data_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        input.conversationId,
        next,
        input.class,
        input.kind,
        input.role ?? null,
        input.visibility,
        input.runId ?? null,
        input.source?.type ?? null,
        input.source?.id ?? null,
        encode(input.content),
        input.data === undefined ? null : encode(input.data),
        timestamp
      );
      return next;
    });
    return conversationItemSchema.parse(rowToConversationItem(this.one("select * from conversation_items where conversation_id = ? and sequence = ?", [input.conversationId, sequence])));
  }

  public async listConversationItems(conversationId: string, input: { after?: number; limit?: number } = {}): Promise<ConversationItem[]> {
    const after = input.after ?? 0;
    const limit = input.limit ?? 1000;
    return this.all("select * from conversation_items where conversation_id = ? and sequence > ? order by sequence asc limit ?", [conversationId, after, limit])
      .map((row) => conversationItemSchema.parse(rowToConversationItem(row)));
  }

  public async getLatestItemSequence(conversationId: string): Promise<number> {
    return Number(this.one("select coalesce(max(sequence), 0) as sequence from conversation_items where conversation_id = ?", [conversationId]).sequence);
  }

  public async createAgentRun(input: { id?: string; conversationId: string; startedThroughItemSequence: number; modelConfig: ModelConfig }): Promise<AgentRunRecord> {
    const id = input.id ?? createId("run");
    const timestamp = nowIso();
    this.db.prepare(
      "insert into agent_runs (id, conversation_id, status, started_through_item_sequence, completed_through_item_sequence, model_config_json, provider_state_id, error_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, input.conversationId, "running", input.startedThroughItemSequence, null, encode(input.modelConfig), null, null, timestamp, timestamp);
    return agentRunRecordSchema.parse(rowToAgentRun(this.one("select * from agent_runs where id = ?", [id])));
  }

  public async getAgentRun(id: string): Promise<AgentRunRecord | undefined> {
    const row = this.oneOptional("select * from agent_runs where id = ?", [id]);
    return row ? agentRunRecordSchema.parse(rowToAgentRun(row)) : undefined;
  }

  public async getActiveAgentRun(conversationId: string): Promise<AgentRunRecord | undefined> {
    const row = this.oneOptional("select * from agent_runs where conversation_id = ? and status = 'running' order by created_at desc limit 1", [conversationId]);
    return row ? agentRunRecordSchema.parse(rowToAgentRun(row)) : undefined;
  }

  public async listAgentRuns(conversationId: string): Promise<AgentRunRecord[]> {
    return this.all("select * from agent_runs where conversation_id = ? order by created_at asc", [conversationId]).map((row) => agentRunRecordSchema.parse(rowToAgentRun(row)));
  }

  public async updateAgentRun(input: { id: string; status?: AgentRunStatus; completedThroughItemSequence?: number; providerStateId?: string; error?: JsonValue }): Promise<AgentRunRecord> {
    const current = await this.getAgentRun(input.id);
    if (!current) {
      throw new Error(`Agent run ${input.id} not found`);
    }
    this.db.prepare("update agent_runs set status = ?, completed_through_item_sequence = ?, provider_state_id = ?, error_json = ?, updated_at = ? where id = ?").run(
      input.status ?? current.status,
      input.completedThroughItemSequence ?? current.completedThroughItemSequence ?? null,
      input.providerStateId ?? current.providerStateId ?? null,
      input.error !== undefined ? encode(input.error) : (current.error === undefined ? null : encode(current.error)),
      nowIso(),
      input.id
    );
    return agentRunRecordSchema.parse(rowToAgentRun(this.one("select * from agent_runs where id = ?", [input.id])));
  }

  public async createContextProjection(input: {
    id?: string;
    conversationId: string;
    itemId: string;
    coversThroughItemSequence: number;
    policyId: string;
    content: ContentBlock[];
    tokenEstimate: number;
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextProjection> {
    const id = input.id ?? createId("proj");
    this.db.prepare("insert into context_projections (id, conversation_id, item_id, covers_through_item_sequence, policy_id, content_json, token_estimate, diagnostics_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      input.conversationId,
      input.itemId,
      input.coversThroughItemSequence,
      input.policyId,
      encode(input.content),
      input.tokenEstimate,
      encode(input.diagnostics ?? {}),
      nowIso()
    );
    return contextProjectionSchema.parse(rowToContextProjection(this.one("select * from context_projections where id = ?", [id])));
  }

  public async listContextProjections(conversationId: string): Promise<ContextProjection[]> {
    return this.all("select * from context_projections where conversation_id = ? order by covers_through_item_sequence asc, created_at asc", [conversationId])
      .map((row) => contextProjectionSchema.parse(rowToContextProjection(row)));
  }

  public async createContextBuild(input: {
    id?: string;
    conversationId: string;
    runId: string;
    modelConfig: ModelConfig;
    projectionId?: string;
    selectedItemIds: string[];
    selectedItemSequences: number[];
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextBuild> {
    const id = input.id ?? createId("ctxbuild");
    this.db.prepare("insert into context_builds (id, conversation_id, run_id, model_config_json, projection_id, selected_item_ids_json, selected_item_sequences_json, diagnostics_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      input.conversationId,
      input.runId,
      encode(input.modelConfig),
      input.projectionId ?? null,
      encode(input.selectedItemIds),
      encode(input.selectedItemSequences),
      encode(input.diagnostics ?? {}),
      nowIso()
    );
    return contextBuildSchema.parse(rowToContextBuild(this.one("select * from context_builds where id = ?", [id])));
  }

  public async listContextBuilds(conversationId: string): Promise<ContextBuild[]> {
    return this.all("select * from context_builds where conversation_id = ? order by created_at asc", [conversationId]).map((row) => contextBuildSchema.parse(rowToContextBuild(row)));
  }

  public async createProviderState(input: {
    id?: string;
    conversationId: string;
    provider: string;
    adapter: string;
    modelId: string;
    payloadVersion: number;
    payload: JsonValue;
    producedThroughItemSequence: number;
    referencedItemSequences: number[];
  }): Promise<ProviderState> {
    const id = input.id ?? createId("pstate");
    this.db.prepare("insert into provider_states (id, conversation_id, provider, adapter, model_id, payload_version, payload_json, produced_through_item_sequence, referenced_item_sequences_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      input.conversationId,
      input.provider,
      input.adapter,
      input.modelId,
      input.payloadVersion,
      encode(input.payload),
      input.producedThroughItemSequence,
      encode(input.referencedItemSequences),
      nowIso()
    );
    return providerStateSchema.parse(rowToProviderState(this.one("select * from provider_states where id = ?", [id])));
  }

  public async getLatestProviderState(conversationId: string): Promise<ProviderState | undefined> {
    const row = this.oneOptional("select * from provider_states where conversation_id = ? order by created_at desc limit 1", [conversationId]);
    return row ? providerStateSchema.parse(rowToProviderState(row)) : undefined;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists settings (
        key text primary key not null,
        value text not null
      );
      create table if not exists profiles (
        id text primary key not null,
        name text not null unique,
        config_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists conversations (
        id text primary key not null,
        profile_name text references profiles(name),
        config_json text not null,
        title text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists conversation_items (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        sequence integer not null,
        item_class text not null,
        kind text not null,
        role text,
        visibility text not null,
        run_id text references agent_runs(id),
        source_type text,
        source_id text,
        content_json text not null,
        data_json text,
        created_at text not null,
        unique(conversation_id, sequence)
      );
      create index if not exists conversation_items_conversation_sequence_idx on conversation_items (conversation_id, sequence);
      create index if not exists conversation_items_class_visibility_idx on conversation_items (conversation_id, item_class, visibility);
      create table if not exists agent_runs (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        status text not null,
        started_through_item_sequence integer not null,
        completed_through_item_sequence integer,
        model_config_json text not null,
        provider_state_id text references provider_states(id),
        error_json text,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists agent_runs_one_active_per_conversation on agent_runs (conversation_id) where status = 'running';
      create table if not exists context_projections (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        item_id text not null references conversation_items(id) on delete cascade,
        covers_through_item_sequence integer not null,
        policy_id text not null,
        content_json text not null,
        token_estimate integer not null,
        diagnostics_json text not null,
        created_at text not null
      );
      create index if not exists context_projections_conversation_idx on context_projections (conversation_id, covers_through_item_sequence);
      create table if not exists context_builds (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        run_id text not null references agent_runs(id) on delete cascade,
        model_config_json text not null,
        projection_id text,
        selected_item_ids_json text not null,
        selected_item_sequences_json text not null,
        diagnostics_json text not null,
        created_at text not null
      );
      create table if not exists provider_states (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        provider text not null,
        adapter text not null,
        model_id text not null,
        payload_version integer not null,
        payload_json text not null,
        produced_through_item_sequence integer not null,
        referenced_item_sequences_json text not null,
        created_at text not null
      );
      create index if not exists provider_states_conversation_idx on provider_states (conversation_id, created_at);
    `);
  }

  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private one(sql: string, values: unknown[] = []): Record<string, unknown> {
    const row = this.db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Expected row for query: ${sql}`);
    }
    return row;
  }

  private oneOptional(sql: string, values: unknown[] = []): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  }

  private all(sql: string, values: unknown[] = []): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected ${key} to be a number`);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function nullableJson(row: Record<string, unknown>, key: string): JsonValue | undefined {
  const value = row[key];
  return typeof value === "string" ? JSON.parse(value) as JsonValue : undefined;
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function rowToProfile(row: Record<string, unknown>): unknown {
  return {
    id: stringField(row, "id"),
    name: stringField(row, "name"),
    config: JSON.parse(stringField(row, "config_json")),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  };
}

function rowToConversation(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    profileName: nullableString(row, "profile_name"),
    config: JSON.parse(stringField(row, "config_json")),
    title: nullableString(row, "title"),
    status: stringField(row, "status"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToConversationItem(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    sequence: numberField(row, "sequence"),
    class: stringField(row, "item_class"),
    kind: stringField(row, "kind"),
    role: nullableString(row, "role"),
    visibility: stringField(row, "visibility"),
    runId: nullableString(row, "run_id"),
    source: nullableString(row, "source_type") ? compact({ type: nullableString(row, "source_type"), id: nullableString(row, "source_id") }) : undefined,
    content: JSON.parse(stringField(row, "content_json")),
    data: nullableJson(row, "data_json"),
    createdAt: stringField(row, "created_at")
  });
}

function rowToAgentRun(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    status: stringField(row, "status"),
    startedThroughItemSequence: numberField(row, "started_through_item_sequence"),
    completedThroughItemSequence: row.completed_through_item_sequence === null ? undefined : numberField(row, "completed_through_item_sequence"),
    modelConfig: JSON.parse(stringField(row, "model_config_json")),
    providerStateId: nullableString(row, "provider_state_id"),
    error: nullableJson(row, "error_json"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToContextProjection(row: Record<string, unknown>): unknown {
  return {
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    itemId: stringField(row, "item_id"),
    coversThroughItemSequence: numberField(row, "covers_through_item_sequence"),
    policyId: stringField(row, "policy_id"),
    content: JSON.parse(stringField(row, "content_json")),
    tokenEstimate: numberField(row, "token_estimate"),
    diagnostics: JSON.parse(stringField(row, "diagnostics_json")),
    createdAt: stringField(row, "created_at")
  };
}

function rowToContextBuild(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    runId: stringField(row, "run_id"),
    modelConfig: JSON.parse(stringField(row, "model_config_json")),
    projectionId: nullableString(row, "projection_id"),
    selectedItemIds: JSON.parse(stringField(row, "selected_item_ids_json")),
    selectedItemSequences: JSON.parse(stringField(row, "selected_item_sequences_json")),
    diagnostics: JSON.parse(stringField(row, "diagnostics_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToProviderState(row: Record<string, unknown>): unknown {
  return {
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    provider: stringField(row, "provider"),
    adapter: stringField(row, "adapter"),
    modelId: stringField(row, "model_id"),
    payloadVersion: numberField(row, "payload_version"),
    payload: JSON.parse(stringField(row, "payload_json")),
    producedThroughItemSequence: numberField(row, "produced_through_item_sequence"),
    referencedItemSequences: JSON.parse(stringField(row, "referenced_item_sequences_json")),
    createdAt: stringField(row, "created_at")
  };
}
