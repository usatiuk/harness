import Database from "better-sqlite3";
import {
    agentRunRecordSchema,
    contextBuildSchema,
    conversationItemInputSchema,
    conversationItemSchema,
    conversationRecordSchema,
    profileRecordSchema,
    providerPayloadSchema,
    type AgentRunRecord,
    type ConversationItem,
    type ConversationRecord,
    type ContextBuild,
    type ModelConfig,
    type ProfileConfig,
    type ProfileRecord,
    type ProviderPayload,
} from "@harness/protocol";
import { createId, nowIso, type HarnessStore } from "@harness/core";

export interface SqliteHarnessStoreOptions {
    path: string;
}

type AppendConversationItemInput = Parameters<
    HarnessStore["appendConversationItem"]
>[0];
type UpdateAgentRunInput = Parameters<HarnessStore["updateAgentRun"]>[0];
type CreateProviderPayloadInput = Parameters<
    HarnessStore["createProviderPayload"]
>[0];
type CommitAssistantResponseInput = Parameters<
    HarnessStore["commitAssistantResponse"]
>[0];
type CommitAssistantResponseResult = Awaited<
    ReturnType<HarnessStore["commitAssistantResponse"]>
>;

export function openSqliteHarnessStore(
    options: SqliteHarnessStoreOptions,
): SqliteHarnessStore {
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

    public async createProfile(input: {
        id?: string;
        name: string;
        config: ProfileConfig;
    }): Promise<ProfileRecord> {
        const id = input.id ?? createId("prof");
        const timestamp = nowIso();
        this.db
            .prepare(
                "insert into profiles (id, name, config_json, created_at, updated_at) values (?, ?, ?, ?, ?)",
            )
            .run(id, input.name, encode(input.config), timestamp, timestamp);
        return this.profileByName(input.name);
    }

    public async listProfiles(): Promise<ProfileRecord[]> {
        return this.all("select * from profiles order by name asc").map((row) =>
            profileRecordSchema.parse({
                id: stringField(row, "id"),
                name: stringField(row, "name"),
                config: decode(stringField(row, "config_json")),
                createdAt: stringField(row, "created_at"),
                updatedAt: stringField(row, "updated_at"),
            }),
        );
    }

    public async getProfileByName(
        name: string,
    ): Promise<ProfileRecord | undefined> {
        const row = this.oneOptional("select * from profiles where name = ?", [
            name,
        ]);
        return row
            ? profileRecordSchema.parse({
                  id: stringField(row, "id"),
                  name: stringField(row, "name"),
                  config: decode(stringField(row, "config_json")),
                  createdAt: stringField(row, "created_at"),
                  updatedAt: stringField(row, "updated_at"),
              })
            : undefined;
    }

    public async setDefaultProfileName(name: string): Promise<void> {
        this.db
            .prepare(
                "insert into settings (key, value) values ('default_profile_name', ?) on conflict(key) do update set value = excluded.value",
            )
            .run(name);
    }

    public async getDefaultProfileName(): Promise<string | undefined> {
        const row = this.oneOptional(
            "select value from settings where key = 'default_profile_name'",
        );
        return row && typeof row.value === "string" ? row.value : undefined;
    }

    public async createConversation(input: {
        id?: string;
        profileName?: string;
        config: ProfileConfig;
        title?: string;
    }): Promise<ConversationRecord> {
        const id = input.id ?? createId("conv");
        const timestamp = nowIso();
        this.db
            .prepare(
                "insert into conversations (id, profile_name, config_json, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                id,
                input.profileName ?? null,
                encode(input.config),
                input.title ?? null,
                "created",
                timestamp,
                timestamp,
            );
        return this.conversationById(id);
    }

    public async getConversation(
        id: string,
    ): Promise<ConversationRecord | undefined> {
        const row = this.oneOptional(
            "select * from conversations where id = ?",
            [id],
        );
        return row ? parseConversation(row) : undefined;
    }

    public async listConversations(): Promise<ConversationRecord[]> {
        return this.all(
            "select * from conversations order by created_at asc",
        ).map(parseConversation);
    }

    public async updateConversation(input: {
        id: string;
        status?: ConversationRecord["status"];
        title?: string;
    }): Promise<ConversationRecord> {
        const current = await this.getConversation(input.id);
        if (!current) {
            throw new Error(`Conversation ${input.id} not found`);
        }
        this.db
            .prepare(
                "update conversations set status = ?, title = ?, updated_at = ? where id = ?",
            )
            .run(
                input.status ?? current.status,
                input.title ?? current.title ?? null,
                nowIso(),
                input.id,
            );
        return this.conversationById(input.id);
    }

    public async appendConversationItem(
        input: AppendConversationItemInput,
    ): Promise<ConversationItem> {
        return this.transaction(() =>
            this.appendConversationItemInTransaction(input),
        );
    }

    public async listConversationItems(
        conversationId: string,
        input: { after?: number; limit?: number } = {},
    ): Promise<ConversationItem[]> {
        const after = input.after ?? 0;
        const limit = input.limit ?? -1;
        return this.all(
            "select * from conversation_items where conversation_id = ? and sequence > ? order by sequence asc limit ?",
            [conversationId, after, limit],
        ).map((row) => this.conversationItemFromEnvelope(row));
    }

    public async getLatestItemSequence(
        conversationId: string,
    ): Promise<number> {
        return this.latestItemSequence(conversationId);
    }

    public async createAgentRun(input: {
        id?: string;
        conversationId: string;
        startedThroughItemSequence: number;
        modelConfig: ModelConfig;
    }): Promise<AgentRunRecord> {
        const id = input.id ?? createId("run");
        const timestamp = nowIso();
        this.db
            .prepare(
                "insert into agent_runs (id, conversation_id, status, started_through_item_sequence, completed_through_item_sequence, model_config_json, output_item_id, provider_response_json, accounting_json, error_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                id,
                input.conversationId,
                "running",
                input.startedThroughItemSequence,
                null,
                encode(input.modelConfig),
                null,
                null,
                null,
                null,
                timestamp,
                timestamp,
            );
        return this.agentRunById(id);
    }

    public async getAgentRun(id: string): Promise<AgentRunRecord | undefined> {
        const row = this.oneOptional("select * from agent_runs where id = ?", [
            id,
        ]);
        return row ? parseAgentRun(row) : undefined;
    }

    public async getActiveAgentRun(
        conversationId: string,
    ): Promise<AgentRunRecord | undefined> {
        const row = this.oneOptional(
            "select * from agent_runs where conversation_id = ? and status = 'running' order by created_at desc limit 1",
            [conversationId],
        );
        return row ? parseAgentRun(row) : undefined;
    }

    public async listAgentRuns(
        conversationId: string,
    ): Promise<AgentRunRecord[]> {
        return this.all(
            "select * from agent_runs where conversation_id = ? order by created_at asc",
            [conversationId],
        ).map(parseAgentRun);
    }

    public async updateAgentRun(
        input: UpdateAgentRunInput,
    ): Promise<AgentRunRecord> {
        return this.transaction(() => this.updateAgentRunInTransaction(input));
    }

    public async commitAssistantResponse(
        input: CommitAssistantResponseInput,
    ): Promise<CommitAssistantResponseResult> {
        return this.transaction(() => {
            const currentRun = this.agentRunById(input.runId);
            if (currentRun.conversationId !== input.conversationId) {
                throw new Error(`Agent run ${input.runId} not found`);
            }
            if (currentRun.status !== "running") {
                throw new Error(
                    `Agent run ${input.runId} is ${currentRun.status}`,
                );
            }

            const assistantItem = this.appendConversationItemInTransaction({
                conversationId: input.conversationId,
                type: "message",
                role: "assistant",
                status: "complete",
                runId: input.runId,
                content: input.content,
            });

            const providerPayload = input.providerPayload
                ? this.createProviderPayloadInTransaction({
                      conversationId: input.conversationId,
                      itemId: assistantItem.id,
                      itemSequence: assistantItem.sequence,
                      provider: input.modelConfig.provider,
                      modelId: input.modelConfig.modelId,
                      type: input.providerPayload.type,
                      version: input.providerPayload.version,
                      payload: input.providerPayload.payload,
                  })
                : undefined;

            const run = this.updateAgentRunInTransaction({
                id: input.runId,
                status: "completed",
                completedThroughItemSequence: this.latestItemSequence(
                    input.conversationId,
                ),
                outputItemId: assistantItem.id,
                ...(input.providerResponse
                    ? { providerResponse: input.providerResponse }
                    : {}),
                ...(input.accounting ? { accounting: input.accounting } : {}),
            });

            return {
                assistantItem,
                ...(providerPayload ? { providerPayload } : {}),
                run,
            };
        });
    }

    public async createContextBuild(input: {
        id?: string;
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        compactionItemId?: string;
        selectedItemIds: string[];
        selectedItemSequences: number[];
        diagnostics?: Record<string, unknown>;
    }): Promise<ContextBuild> {
        const id = input.id ?? createId("ctxbuild");
        this.db
            .prepare(
                "insert into context_builds (id, conversation_id, run_id, model_config_json, compaction_item_id, selected_item_ids_json, selected_item_sequences_json, diagnostics_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                id,
                input.conversationId,
                input.runId,
                encode(input.modelConfig),
                input.compactionItemId ?? null,
                encode(input.selectedItemIds),
                encode(input.selectedItemSequences),
                encode(input.diagnostics ?? {}),
                nowIso(),
            );
        return contextBuildSchema.parse(
            rowToContextBuild(
                this.one("select * from context_builds where id = ?", [id]),
            ),
        );
    }

    public async listContextBuilds(
        conversationId: string,
    ): Promise<ContextBuild[]> {
        return this.all(
            "select * from context_builds where conversation_id = ? order by created_at asc",
            [conversationId],
        ).map((row) => contextBuildSchema.parse(rowToContextBuild(row)));
    }

    public async createProviderPayload(
        input: CreateProviderPayloadInput,
    ): Promise<ProviderPayload> {
        return this.transaction(() =>
            this.createProviderPayloadInTransaction(input),
        );
    }

    public async listProviderPayloadsForItems(input: {
        conversationId: string;
        itemIds: string[];
        provider: string;
        modelId: string;
    }): Promise<ProviderPayload[]> {
        if (input.itemIds.length === 0) {
            return [];
        }
        const placeholders = input.itemIds.map(() => "?").join(", ");
        return this.all(
            `select * from provider_payloads where conversation_id = ? and provider = ? and model_id = ? and item_id in (${placeholders}) order by item_sequence asc, created_at desc`,
            [
                input.conversationId,
                input.provider,
                input.modelId,
                ...input.itemIds,
            ],
        ).map((row) => providerPayloadSchema.parse(rowToProviderPayload(row)));
    }

    private appendConversationItemInTransaction(
        rawInput: AppendConversationItemInput,
    ): ConversationItem {
        const input = conversationItemInputSchema.parse(rawInput);
        const id = input.id ?? createId("item");
        const timestamp = nowIso();
        const sequence = this.latestItemSequence(input.conversationId) + 1;
        this.db
            .prepare(
                "insert into conversation_items (id, conversation_id, sequence, type, created_at) values (?, ?, ?, ?, ?)",
            )
            .run(id, input.conversationId, sequence, input.type, timestamp);

        switch (input.type) {
            case "message":
                this.db
                    .prepare(
                        "insert into conversation_messages (item_id, role, status, content_json, run_id, source_item_id) values (?, ?, ?, ?, ?, ?)",
                    )
                    .run(
                        id,
                        input.role,
                        input.status,
                        encode(input.content),
                        input.runId ?? null,
                        input.sourceItemId ?? null,
                    );
                break;
            case "model_change":
                this.db
                    .prepare(
                        "insert into conversation_model_changes (item_id, provider, model_id, settings_json) values (?, ?, ?, ?)",
                    )
                    .run(
                        id,
                        input.provider,
                        input.modelId,
                        input.settings ? encode(input.settings) : null,
                    );
                break;
            case "compaction":
                this.db
                    .prepare(
                        "insert into conversation_compactions (item_id, summary_json, covers_through_item_sequence, first_kept_item_id, policy_id, token_estimate) values (?, ?, ?, ?, ?, ?)",
                    )
                    .run(
                        id,
                        encode(input.summary),
                        input.coversThroughItemSequence,
                        input.firstKeptItemId ?? null,
                        input.policyId,
                        input.tokenEstimate,
                    );
                break;
            case "model_error":
                this.db
                    .prepare(
                        "insert into conversation_model_errors (item_id, run_id, message, error_json) values (?, ?, ?, ?)",
                    )
                    .run(
                        id,
                        input.runId,
                        input.message,
                        input.error === undefined ? null : encode(input.error),
                    );
                break;
        }

        return this.conversationItemById(id);
    }

    private updateAgentRunInTransaction(
        input: UpdateAgentRunInput,
    ): AgentRunRecord {
        const current = this.agentRunById(input.id);
        this.db
            .prepare(
                "update agent_runs set status = ?, completed_through_item_sequence = ?, output_item_id = ?, provider_response_json = ?, accounting_json = ?, error_json = ?, updated_at = ? where id = ?",
            )
            .run(
                input.status ?? current.status,
                input.completedThroughItemSequence ??
                    current.completedThroughItemSequence ??
                    null,
                input.outputItemId ?? current.outputItemId ?? null,
                input.providerResponse
                    ? encode(input.providerResponse)
                    : current.providerResponse
                      ? encode(current.providerResponse)
                      : null,
                input.accounting
                    ? encode(input.accounting)
                    : current.accounting
                      ? encode(current.accounting)
                      : null,
                input.error !== undefined
                    ? encode(input.error)
                    : current.error === undefined
                      ? null
                      : encode(current.error),
                nowIso(),
                input.id,
            );
        return this.agentRunById(input.id);
    }

    private createProviderPayloadInTransaction(
        input: CreateProviderPayloadInput,
    ): ProviderPayload {
        const id = input.id ?? createId("ppay");
        this.db
            .prepare(
                "insert into provider_payloads (id, conversation_id, item_id, item_sequence, provider, model_id, type, version, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                id,
                input.conversationId,
                input.itemId,
                input.itemSequence,
                input.provider,
                input.modelId,
                input.type,
                input.version,
                encode(input.payload),
                nowIso(),
            );
        return providerPayloadSchema.parse(
            rowToProviderPayload(
                this.one("select * from provider_payloads where id = ?", [id]),
            ),
        );
    }

    private profileByName(name: string): ProfileRecord {
        const row = this.one("select * from profiles where name = ?", [name]);
        return profileRecordSchema.parse({
            id: stringField(row, "id"),
            name: stringField(row, "name"),
            config: decode(stringField(row, "config_json")),
            createdAt: stringField(row, "created_at"),
            updatedAt: stringField(row, "updated_at"),
        });
    }

    private conversationById(id: string): ConversationRecord {
        return parseConversation(
            this.one("select * from conversations where id = ?", [id]),
        );
    }

    private agentRunById(id: string): AgentRunRecord {
        return parseAgentRun(
            this.one("select * from agent_runs where id = ?", [id]),
        );
    }

    private conversationItemById(id: string): ConversationItem {
        return this.conversationItemFromEnvelope(
            this.one("select * from conversation_items where id = ?", [id]),
        );
    }

    private conversationItemFromEnvelope(
        envelope: Record<string, unknown>,
    ): ConversationItem {
        const type = stringField(envelope, "type");
        const base = {
            id: stringField(envelope, "id"),
            conversationId: stringField(envelope, "conversation_id"),
            sequence: numberField(envelope, "sequence"),
            createdAt: stringField(envelope, "created_at"),
        };
        switch (type) {
            case "message": {
                const row = this.one(
                    "select * from conversation_messages where item_id = ?",
                    [base.id],
                );
                return conversationItemSchema.parse({
                    ...base,
                    type,
                    role: stringField(row, "role"),
                    status: stringField(row, "status"),
                    content: decode(stringField(row, "content_json")),
                    runId: nullableString(row, "run_id"),
                    sourceItemId: nullableString(row, "source_item_id"),
                });
            }
            case "model_change": {
                const row = this.one(
                    "select * from conversation_model_changes where item_id = ?",
                    [base.id],
                );
                return conversationItemSchema.parse({
                    ...base,
                    type,
                    provider: stringField(row, "provider"),
                    modelId: stringField(row, "model_id"),
                    settings: nullableDecode(row, "settings_json"),
                });
            }
            case "compaction": {
                const row = this.one(
                    "select * from conversation_compactions where item_id = ?",
                    [base.id],
                );
                return conversationItemSchema.parse({
                    ...base,
                    type,
                    summary: decode(stringField(row, "summary_json")),
                    coversThroughItemSequence: numberField(
                        row,
                        "covers_through_item_sequence",
                    ),
                    firstKeptItemId: nullableString(row, "first_kept_item_id"),
                    policyId: stringField(row, "policy_id"),
                    tokenEstimate: numberField(row, "token_estimate"),
                });
            }
            case "model_error": {
                const row = this.one(
                    "select * from conversation_model_errors where item_id = ?",
                    [base.id],
                );
                return conversationItemSchema.parse({
                    ...base,
                    type,
                    runId: stringField(row, "run_id"),
                    message: stringField(row, "message"),
                    error: nullableDecode(row, "error_json"),
                });
            }
            default:
                throw new Error(`Unknown conversation item type ${type}`);
        }
    }

    private migrate(): void {
        this.resetIncompatibleConversationSchemaIfPresent();
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
        type text not null,
        created_at text not null,
        unique(conversation_id, sequence)
      );
      create index if not exists conversation_items_conversation_sequence_idx on conversation_items (conversation_id, sequence);
      create table if not exists conversation_messages (
        item_id text primary key not null references conversation_items(id) on delete cascade,
        role text not null,
        status text not null,
        content_json text not null,
        run_id text references agent_runs(id),
        source_item_id text
      );
      create table if not exists conversation_model_changes (
        item_id text primary key not null references conversation_items(id) on delete cascade,
        provider text not null,
        model_id text not null,
        settings_json text
      );
      create table if not exists conversation_compactions (
        item_id text primary key not null references conversation_items(id) on delete cascade,
        summary_json text not null,
        covers_through_item_sequence integer not null,
        first_kept_item_id text,
        policy_id text not null,
        token_estimate integer not null
      );
      create table if not exists conversation_model_errors (
        item_id text primary key not null references conversation_items(id) on delete cascade,
        run_id text not null references agent_runs(id),
        message text not null,
        error_json text
      );
      create table if not exists agent_runs (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        status text not null,
        started_through_item_sequence integer not null,
        completed_through_item_sequence integer,
        model_config_json text not null,
        output_item_id text,
        provider_response_json text,
        accounting_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists agent_runs_one_active_per_conversation on agent_runs (conversation_id) where status = 'running';
      create table if not exists context_builds (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        run_id text not null references agent_runs(id) on delete cascade,
        model_config_json text not null,
        compaction_item_id text,
        selected_item_ids_json text not null,
        selected_item_sequences_json text not null,
        diagnostics_json text not null,
        created_at text not null
      );
      create table if not exists provider_payloads (
        id text primary key not null,
        conversation_id text not null references conversations(id) on delete cascade,
        item_id text not null references conversation_items(id) on delete cascade,
        item_sequence integer not null,
        provider text not null,
        model_id text not null,
        type text not null,
        version integer not null,
        payload_json text not null,
        created_at text not null,
        unique(item_id, provider, model_id, type, version)
      );
      create index if not exists provider_payloads_lookup_idx on provider_payloads (conversation_id, provider, model_id, item_sequence);
    `);
    }

    private resetIncompatibleConversationSchemaIfPresent(): void {
        const itemColumns = new Set(this.tableColumns("conversation_items"));
        if (itemColumns.size === 0) {
            return;
        }
        if (itemColumns.has("type") && itemColumns.has("conversation_id")) {
            return;
        }

        const keep = new Set(["profiles", "settings"]);
        const tables = this.all(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
        )
            .map((row) => stringField(row, "name"))
            .filter((name) => !keep.has(name));
        if (tables.length === 0) {
            return;
        }

        this.db.pragma("foreign_keys = OFF");
        try {
            for (const table of tables) {
                this.db.exec(`drop table if exists ${sqliteIdentifier(table)}`);
            }
        } finally {
            this.db.pragma("foreign_keys = ON");
        }
    }

    private tableColumns(table: string): string[] {
        return this.all(`pragma table_info(${sqliteIdentifier(table)})`).map(
            (row) => stringField(row, "name"),
        );
    }

    private transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    private latestItemSequence(conversationId: string): number {
        return Number(
            this.one(
                "select coalesce(max(sequence), 0) as sequence from conversation_items where conversation_id = ?",
                [conversationId],
            ).sequence,
        );
    }

    private one(sql: string, values: unknown[] = []): Record<string, unknown> {
        const row = this.db.prepare(sql).get(...values) as
            | Record<string, unknown>
            | undefined;
        if (!row) {
            throw new Error(`Expected row for query: ${sql}`);
        }
        return row;
    }

    private oneOptional(
        sql: string,
        values: unknown[] = [],
    ): Record<string, unknown> | undefined {
        return this.db.prepare(sql).get(...values) as
            | Record<string, unknown>
            | undefined;
    }

    private all(
        sql: string,
        values: unknown[] = [],
    ): Array<Record<string, unknown>> {
        return this.db.prepare(sql).all(...values) as Array<
            Record<string, unknown>
        >;
    }
}

function parseConversation(row: Record<string, unknown>): ConversationRecord {
    return conversationRecordSchema.parse({
        id: stringField(row, "id"),
        profileName: nullableString(row, "profile_name"),
        config: decode(stringField(row, "config_json")),
        title: nullableString(row, "title"),
        status: stringField(row, "status"),
        createdAt: stringField(row, "created_at"),
        updatedAt: stringField(row, "updated_at"),
    });
}

function parseAgentRun(row: Record<string, unknown>): AgentRunRecord {
    return agentRunRecordSchema.parse({
        id: stringField(row, "id"),
        conversationId: stringField(row, "conversation_id"),
        status: stringField(row, "status"),
        startedThroughItemSequence: numberField(
            row,
            "started_through_item_sequence",
        ),
        completedThroughItemSequence: nullableNumber(
            row,
            "completed_through_item_sequence",
        ),
        modelConfig: decode(stringField(row, "model_config_json")),
        outputItemId: nullableString(row, "output_item_id"),
        providerResponse: nullableDecode(row, "provider_response_json"),
        accounting: nullableDecode(row, "accounting_json"),
        error: nullableDecode(row, "error_json"),
        createdAt: stringField(row, "created_at"),
        updatedAt: stringField(row, "updated_at"),
    });
}

function rowToContextBuild(row: Record<string, unknown>): unknown {
    return {
        id: stringField(row, "id"),
        conversationId: stringField(row, "conversation_id"),
        runId: stringField(row, "run_id"),
        modelConfig: decode(stringField(row, "model_config_json")),
        compactionItemId: nullableString(row, "compaction_item_id"),
        selectedItemIds: decode(stringField(row, "selected_item_ids_json")),
        selectedItemSequences: decode(
            stringField(row, "selected_item_sequences_json"),
        ),
        diagnostics: decode(stringField(row, "diagnostics_json")),
        createdAt: stringField(row, "created_at"),
    };
}

function rowToProviderPayload(row: Record<string, unknown>): unknown {
    return {
        id: stringField(row, "id"),
        conversationId: stringField(row, "conversation_id"),
        itemId: stringField(row, "item_id"),
        itemSequence: numberField(row, "item_sequence"),
        provider: stringField(row, "provider"),
        modelId: stringField(row, "model_id"),
        type: stringField(row, "type"),
        version: numberField(row, "version"),
        payload: decode(stringField(row, "payload_json")),
        createdAt: stringField(row, "created_at"),
    };
}

function encode(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new Error("Value is not JSON-encodable");
    }
    return encoded;
}

function decode(value: string): unknown {
    return JSON.parse(value) as unknown;
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

function nullableString(
    row: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = row[key];
    return typeof value === "string" ? value : undefined;
}

function nullableNumber(
    row: Record<string, unknown>,
    key: string,
): number | undefined {
    const value = row[key];
    return typeof value === "number" ? value : undefined;
}

function nullableDecode(
    row: Record<string, unknown>,
    key: string,
): unknown | undefined {
    const value = row[key];
    return typeof value === "string" ? decode(value) : undefined;
}

function sqliteIdentifier(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
        throw new Error(`Invalid SQLite identifier: ${value}`);
    }
    return `"${value}"`;
}
