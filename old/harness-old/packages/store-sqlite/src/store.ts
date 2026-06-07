import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createId, nowIso, type HarnessStore, type PageRequest } from "@harness/core";
import {
  type ActivityRecord,
  type ActivityStatus,
  activityRecordSchema,
  type ArtifactRecord,
  artifactRecordSchema,
  type AssetOrigin,
  type AssetRecord,
  assetRecordSchema,
  type ContentBlock,
  contentBlockSchema,
  type ContextBlock,
  type ContextBlockKind,
  contextBlockSchema,
  type ContextBlockSource,
  contextBlockSourceSchema,
  type ContextBuild,
  contextBuildSchema,
  type ContextBuildItem,
  contextBuildItemSchema,
  type ContextModelMetadata,
  contextModelMetadataSchema,
  type EffectiveProfile,
  effectiveProfileSchema,
  type ExecutionContextRecord,
  executionContextRecordSchema,
  type HarnessEvent,
  harnessEventSchema,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionRequest,
  interactionRequestSchema,
  type InteractionStatus,
  type JsonValue,
  type MessageRecord,
  type MessageRole,
  messageRecordSchema,
  type ModelConfig,
  modelConfigSchema,
  type ProfileConfig,
  type ProfileRecord,
  type ProviderResumeState,
  profileRecordSchema,
  type ConversationRecord,
  type ConversationStatus,
  conversationRecordSchema,
  type StateNamespaceRecord,
  stateNamespaceRecordSchema,
  type ToolCall,
  toolCallSchema,
  type TurnState,
  turnStateSchema,
  type TurnStatePhase,
  type ConversationInputRecord,
  conversationInputRecordSchema,
  type ConversationInputSource,
  type ConversationInputStatus,
  type ConversationInputTarget,
  type TurnRecord,
  turnRecordSchema,
  type TurnStatus,
  type WorkspaceRecord,
  workspaceRecordSchema,
  type ToolExecutionRecord,
  toolExecutionRecordSchema,
  type ToolExecutionStatus,
  type SourceRef,
  sourceRefSchema,
  type ToolResult
} from "@harness/protocol";
import * as schema from "./schema.ts";

export const SOURCE_FIRST_MARKER = "store-sqlite:src";

export interface SqliteHarnessStoreOptions {
  dbPath: string;
  migrate?: boolean;
  busyTimeoutMs?: number;
  writeRetry?: {
    attempts?: number;
    delayMs?: number;
  };
}

type SqliteValue = string | number | bigint | Buffer | null;

export class SqliteHarnessStore implements HarnessStore {
  private readonly sqlite: Database.Database;
  private readonly writeRetryAttempts: number;
  private readonly writeRetryDelayMs: number;

  private constructor(sqlite: Database.Database, options: SqliteHarnessStoreOptions) {
    this.sqlite = sqlite;
    this.writeRetryAttempts = options.writeRetry?.attempts ?? 5;
    this.writeRetryDelayMs = options.writeRetry?.delayMs ?? 10;
  }

  public static async open(options: SqliteHarnessStoreOptions): Promise<SqliteHarnessStore> {
    if (options.dbPath !== ":memory:") {
      await mkdir(path.dirname(options.dbPath), { recursive: true });
    }
    const sqlite = new Database(options.dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    if (options.migrate ?? true) {
      const db = drizzle(sqlite, { schema });
      const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
      migrate(db, { migrationsFolder });
    }
    return new SqliteHarnessStore(sqlite, options);
  }

  public close(): void {
    this.sqlite.close();
  }

  public async createProfile(input: { id?: string; name: string; config: ProfileConfig }): Promise<ProfileRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("profile");
    this.run("insert into profiles (id, name, config_json, created_at, updated_at) values (?, ?, ?, ?, ?)", [
      id,
      input.name,
      encode(input.config),
      timestamp,
      timestamp
    ]);
    return requireRow(profileRecordSchema, this.one("select * from profiles where id = ?", [id]), rowToProfile);
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    return this.all("select * from profiles order by created_at asc", []).map((row) => requireRow(profileRecordSchema, row, rowToProfile));
  }

  public async getProfile(id: string): Promise<ProfileRecord | undefined> {
    const row = this.one("select * from profiles where id = ?", [id]);
    return row ? requireRow(profileRecordSchema, row, rowToProfile) : undefined;
  }

  public async getProfileByName(name: string): Promise<ProfileRecord | undefined> {
    const row = this.one("select * from profiles where name = ?", [name]);
    return row ? requireRow(profileRecordSchema, row, rowToProfile) : undefined;
  }

  public async updateProfile(id: string, config: ProfileConfig): Promise<ProfileRecord> {
    const timestamp = nowIso();
    this.run("update profiles set config_json = ?, updated_at = ? where id = ?", [encode(config), timestamp, id]);
    return requireRow(profileRecordSchema, this.one("select * from profiles where id = ?", [id]), rowToProfile);
  }

  public async setDefaultProfileId(profileId: string): Promise<void> {
    await this.setPluginKv("plugin.profiles", "defaultProfileId", profileId);
  }

  public async getDefaultProfileId(): Promise<string | undefined> {
    const value = await this.getPluginKv("plugin.profiles", "defaultProfileId");
    return typeof value === "string" ? value : undefined;
  }

  public async createConversation(input: {
    id?: string;
    parentConversationId?: string;
    profileId?: string;
    effectiveProfile: EffectiveProfile;
    executionContextId?: string;
    title?: string;
  }): Promise<ConversationRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("conv");
    this.run(
      "insert into conversations (id, parent_conversation_id, profile_id, effective_profile_json, execution_context_id, provider_resume_state_json, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.parentConversationId ?? null,
        input.profileId ?? null,
        encode(input.effectiveProfile),
        input.executionContextId ?? null,
        null,
        input.title ?? null,
        "created",
        timestamp,
        timestamp
      ]
    );
    return requireRow(conversationRecordSchema, this.one("select * from conversations where id = ?", [id]), rowToConversation);
  }

  public async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const row = this.one("select * from conversations where id = ?", [id]);
    return row ? requireRow(conversationRecordSchema, row, rowToConversation) : undefined;
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return this.all("select * from conversations order by created_at asc", []).map((row) => requireRow(conversationRecordSchema, row, rowToConversation));
  }

  public async updateConversation(input: {
    id: string;
    status?: ConversationStatus;
    executionContextId?: string;
    effectiveProfile?: EffectiveProfile;
    providerResumeState?: ProviderResumeState;
  }): Promise<ConversationRecord> {
    const current = await this.getConversation(input.id);
    if (!current) {
      throw new Error(`Conversation ${input.id} not found`);
    }
    const timestamp = nowIso();
    this.run(
      "update conversations set status = ?, execution_context_id = ?, effective_profile_json = ?, provider_resume_state_json = ?, updated_at = ? where id = ?",
      [
        input.status ?? current.status,
        input.executionContextId ?? current.executionContextId ?? null,
        encode(input.effectiveProfile ?? current.effectiveProfile),
        input.providerResumeState === undefined ? (current.providerResumeState === undefined ? null : encode(current.providerResumeState)) : encode(input.providerResumeState),
        timestamp,
        input.id
      ]
    );
    return requireRow(conversationRecordSchema, this.one("select * from conversations where id = ?", [input.id]), rowToConversation);
  }

  public async createTurn(input: {
    id?: string;
    conversationId: string;
    parentTurnId?: string;
    status?: TurnStatus;
    inputMessageIds?: string[];
  }): Promise<TurnRecord> {
    const row = await this.immediateWrite(() => {
      const status = input.status ?? "running";
      if (status === "running" || status === "waiting") {
        const active = this.one("select id from turns where conversation_id = ? and status in ('running', 'waiting') limit 1", [input.conversationId]);
        if (active) {
          throw new Error(`Conversation ${input.conversationId} already has an active turn`);
        }
      }
      const timestamp = nowIso();
      const id = input.id ?? createId("turn");
      this.run(
        "insert into turns (id, conversation_id, parent_turn_id, status, input_message_ids_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        [id, input.conversationId, input.parentTurnId ?? null, status, encode(input.inputMessageIds ?? []), timestamp, timestamp]
      );
      return this.one("select * from turns where id = ?", [id]);
    });
    return requireRow(turnRecordSchema, row, rowToTurn);
  }

  public async getTurn(id: string): Promise<TurnRecord | undefined> {
    const row = this.one("select * from turns where id = ?", [id]);
    return row ? requireRow(turnRecordSchema, row, rowToTurn) : undefined;
  }

  public async getActiveTurn(conversationId: string): Promise<TurnRecord | undefined> {
    const row = this.one("select * from turns where conversation_id = ? and status in ('running', 'waiting') order by created_at desc limit 1", [conversationId]);
    return row ? requireRow(turnRecordSchema, row, rowToTurn) : undefined;
  }

  public async listTurns(conversationId: string): Promise<TurnRecord[]> {
    return this.all("select * from turns where conversation_id = ? order by created_at asc", [conversationId]).map((row) => requireRow(turnRecordSchema, row, rowToTurn));
  }

  public async updateTurn(input: { id: string; status?: TurnStatus; inputMessageIds?: string[] }): Promise<TurnRecord> {
    const current = await this.getTurn(input.id);
    if (!current) {
      throw new Error(`Turn ${input.id} not found`);
    }
    const status = input.status ?? current.status;
    if (status === "running" || status === "waiting") {
      const active = this.one("select id from turns where conversation_id = ? and status in ('running', 'waiting') and id <> ? limit 1", [current.conversationId, input.id]);
      if (active) {
        throw new Error(`Conversation ${current.conversationId} already has an active turn`);
      }
    }
    const timestamp = nowIso();
    this.run("update turns set status = ?, input_message_ids_json = ?, updated_at = ? where id = ?", [
      status,
      encode(input.inputMessageIds ?? current.inputMessageIds),
      timestamp,
      input.id
    ]);
    return requireRow(turnRecordSchema, this.one("select * from turns where id = ?", [input.id]), rowToTurn);
  }

  public async createMessage(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    role: MessageRole;
    content: ContentBlock[];
    source?: SourceRef;
  }): Promise<MessageRecord> {
    for (const block of input.content) {
      contentBlockSchema.parse(block);
    }
    const row = await this.immediateWrite(() => {
      const aggregate = requiredRowObject(this.one("select coalesce(max(sequence), -1) + 1 as next_sequence from messages where conversation_id = ?", [input.conversationId]));
      const sequence = numberField(aggregate, "next_sequence");
      const timestamp = nowIso();
      const id = input.id ?? createId("msg");
      this.run("insert into messages (id, conversation_id, sequence, turn_id, role, content_json, source_type, source_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        id,
        input.conversationId,
        sequence,
        input.turnId ?? null,
        input.role,
        encode(input.content),
        input.source?.type ?? null,
        input.source?.id ?? null,
        timestamp
      ]);
      return this.one("select * from messages where id = ?", [id]);
    });
    return requireRow(messageRecordSchema, row, rowToMessage);
  }

  public async listMessages(conversationId: string, input?: { limit?: number }): Promise<MessageRecord[]> {
    const limit = input?.limit ?? 50;
    const rows = this.all(
      "select * from (select * from messages where conversation_id = ? order by sequence desc limit ?) order by sequence asc",
      [conversationId, limit]
    );
    return rows.map((row) => requireRow(messageRecordSchema, row, rowToMessage));
  }

  public async createActivity(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    parentActivityId?: string;
    ownerPluginId: string;
    kind: string;
    label: string;
    status?: ActivityStatus;
    cancellable?: boolean;
    activityState?: JsonValue;
    onCompletion?: { delivery: "asap" | "after_active" | "manual" };
  }): Promise<ActivityRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("act");
    this.run(
      "insert into activities (id, conversation_id, turn_id, parent_activity_id, owner_plugin_id, kind, label, status, cancellable, activity_state_json, result_json, on_completion_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.parentActivityId ?? null,
        input.ownerPluginId,
        input.kind,
        input.label,
        input.status ?? "queued",
        input.cancellable === false ? 0 : 1,
        input.activityState === undefined ? null : encode(input.activityState),
        null,
        input.onCompletion === undefined ? null : encode(input.onCompletion),
        timestamp,
        timestamp
      ]
    );
    return requireRow(activityRecordSchema, this.one("select * from activities where id = ?", [id]), rowToActivity);
  }

  public async updateActivity(input: { id: string; status?: ActivityStatus; activityState?: JsonValue; result?: JsonValue }): Promise<ActivityRecord> {
    const current = await this.getActivity(input.id);
    if (!current) {
      throw new Error(`Activity ${input.id} not found`);
    }
    const timestamp = nowIso();
    this.run("update activities set status = ?, activity_state_json = ?, result_json = ?, updated_at = ? where id = ?", [
      input.status ?? current.status,
      input.activityState === undefined ? (current.activityState === undefined ? null : encode(current.activityState)) : encode(input.activityState),
      input.result === undefined ? (current.result === undefined ? null : encode(current.result)) : encode(input.result),
      timestamp,
      input.id
    ]);
    return requireRow(activityRecordSchema, this.one("select * from activities where id = ?", [input.id]), rowToActivity);
  }

  public async getActivity(id: string): Promise<ActivityRecord | undefined> {
    const row = this.one("select * from activities where id = ?", [id]);
    return row ? requireRow(activityRecordSchema, row, rowToActivity) : undefined;
  }

  public async listActivities(conversationId: string): Promise<ActivityRecord[]> {
    return this.all("select * from activities where conversation_id = ? order by created_at asc", [conversationId]).map((row) =>
      requireRow(activityRecordSchema, row, rowToActivity)
    );
  }

  public async appendEvent(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    type: string;
    payload: JsonValue;
  }): Promise<HarnessEvent> {
    const timestamp = nowIso();
    const id = input.id ?? createId("evt");
    const info = this.run("insert into events (id, conversation_id, turn_id, source_type, source_id, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      input.conversationId,
      input.turnId ?? null,
      input.source?.type ?? null,
      input.source?.id ?? null,
      input.type,
      encode(input.payload),
      timestamp
    ]);
    return requireRow(harnessEventSchema, this.one("select * from events where sequence = ?", [Number(info.lastInsertRowid)]), rowToEvent);
  }

  public async listEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]> {
    const after = page?.after ?? 0;
    const limit = page?.limit ?? 50;
    return this.all("select * from events where conversation_id = ? and sequence > ? order by sequence asc limit ?", [conversationId, after, limit]).map((row) =>
      requireRow(harnessEventSchema, row, rowToEvent)
    );
  }

  public async createAsset(input: {
    id?: string;
    conversationId?: string;
    turnId?: string;
    source?: SourceRef;
    messageId?: string;
    uri: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
    origin: AssetOrigin;
    metadata?: Record<string, JsonValue>;
    derivedFromAssetId?: string;
  }): Promise<AssetRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("asset");
    this.run(
      "insert into assets (id, conversation_id, turn_id, source_type, source_id, message_id, uri, mime_type, byte_size, sha256, origin_json, metadata_json, derived_from_asset_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId ?? null,
        input.turnId ?? null,
        input.source?.type ?? null,
        input.source?.id ?? null,
        input.messageId ?? null,
        input.uri,
        input.mimeType,
        input.byteSize,
        input.sha256 ?? null,
        encode(input.origin),
        encode(input.metadata ?? {}),
        input.derivedFromAssetId ?? null,
        timestamp
      ]
    );
    return requireRow(assetRecordSchema, this.one("select * from assets where id = ?", [id]), rowToAsset);
  }

  public async getAsset(id: string): Promise<AssetRecord | undefined> {
    const row = this.one("select * from assets where id = ?", [id]);
    return row ? requireRow(assetRecordSchema, row, rowToAsset) : undefined;
  }

  public async listAssets(conversationId?: string): Promise<AssetRecord[]> {
    const rows = conversationId ? this.all("select * from assets where conversation_id = ? order by created_at asc", [conversationId]) : this.all("select * from assets order by created_at asc", []);
    return rows.map((row) => requireRow(assetRecordSchema, row, rowToAsset));
  }

  public async createArtifact(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    kind: string;
    uri?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ArtifactRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("artifact");
    this.run("insert into artifacts (id, conversation_id, turn_id, source_type, source_id, kind, uri, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      input.conversationId,
      input.turnId ?? null,
      input.source?.type ?? null,
      input.source?.id ?? null,
      input.kind,
      input.uri ?? null,
      encode(input.metadata ?? {}),
      timestamp
    ]);
    return requireRow(artifactRecordSchema, this.one("select * from artifacts where id = ?", [id]), rowToArtifact);
  }

  public async listArtifacts(conversationId: string): Promise<ArtifactRecord[]> {
    return this.all("select * from artifacts where conversation_id = ? order by created_at asc", [conversationId]).map((row) =>
      requireRow(artifactRecordSchema, row, rowToArtifact)
    );
  }

  public async getStateNamespace(conversationId: string, namespace: string): Promise<StateNamespaceRecord | undefined> {
    const row = this.one("select * from state_namespaces where conversation_id = ? and namespace = ?", [conversationId, namespace]);
    return row ? requireRow(stateNamespaceRecordSchema, row, rowToStateNamespace) : undefined;
  }

  public async upsertStateNamespace(input: { conversationId: string; namespace: string; value: JsonValue }): Promise<StateNamespaceRecord> {
    const tx = this.sqlite.transaction(() => {
      const current = this.one("select * from state_namespaces where conversation_id = ? and namespace = ?", [input.conversationId, input.namespace]);
      const timestamp = nowIso();
      if (current) {
        const version = numberField(current, "version") + 1;
        this.run("update state_namespaces set value_json = ?, version = ?, updated_at = ? where conversation_id = ? and namespace = ?", [
          encode(input.value),
          version,
          timestamp,
          input.conversationId,
          input.namespace
        ]);
      } else {
        this.run("insert into state_namespaces (conversation_id, namespace, value_json, version, updated_at) values (?, ?, ?, ?, ?)", [
          input.conversationId,
          input.namespace,
          encode(input.value),
          1,
          timestamp
        ]);
      }
      return this.one("select * from state_namespaces where conversation_id = ? and namespace = ?", [input.conversationId, input.namespace]);
    });
    return requireRow(stateNamespaceRecordSchema, tx(), rowToStateNamespace);
  }

  public async listStateNamespaces(conversationId: string): Promise<StateNamespaceRecord[]> {
    return this.all("select * from state_namespaces where conversation_id = ? order by namespace asc", [conversationId]).map((row) =>
      requireRow(stateNamespaceRecordSchema, row, rowToStateNamespace)
    );
  }

  public async createWorkspace(input: {
    id?: string;
    kind: string;
    rootPath?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<WorkspaceRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("workspace");
    this.run("insert into workspaces (id, kind, root_path, metadata_json, created_at) values (?, ?, ?, ?, ?)", [
      id,
      input.kind,
      input.rootPath ?? null,
      encode(input.metadata ?? {}),
      timestamp
    ]);
    return requireRow(workspaceRecordSchema, this.one("select * from workspaces where id = ?", [id]), rowToWorkspace);
  }

  public async createExecutionContext(input: {
    id?: string;
    conversationId?: string;
    workspaceId?: string;
    providerKind: string;
    cwd?: string;
    env?: Record<string, string>;
    providerConfig?: JsonValue;
    status?: ExecutionContextRecord["status"];
  }): Promise<ExecutionContextRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("ctx");
    this.run(
      "insert into execution_contexts (id, conversation_id, workspace_id, provider_kind, cwd, env_json, provider_config_json, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId ?? null,
        input.workspaceId ?? null,
        input.providerKind,
        input.cwd ?? null,
        encode(input.env ?? {}),
        input.providerConfig === undefined ? null : encode(input.providerConfig),
        input.status ?? "ready",
        timestamp,
        timestamp
      ]
    );
    return requireRow(executionContextRecordSchema, this.one("select * from execution_contexts where id = ?", [id]), rowToExecutionContext);
  }

  public async getExecutionContext(id: string): Promise<ExecutionContextRecord | undefined> {
    const row = this.one("select * from execution_contexts where id = ?", [id]);
    return row ? requireRow(executionContextRecordSchema, row, rowToExecutionContext) : undefined;
  }

  public async listExecutionContexts(conversationId?: string): Promise<ExecutionContextRecord[]> {
    const rows = conversationId
      ? this.all("select * from execution_contexts where conversation_id = ? order by created_at asc", [conversationId])
      : this.all("select * from execution_contexts order by created_at asc", []);
    return rows.map((row) => requireRow(executionContextRecordSchema, row, rowToExecutionContext));
  }

  public async saveTurnState(input: {
    id?: string;
    conversationId: string;
    turnId: string;
    phase: TurnStatePhase;
    activeToolExecutionId?: string;
    activeActivityId?: string;
    contextBuildId?: string;
    pendingToolCalls?: ToolCall[];
    completedToolCallIds?: string[];
    pendingInteractionIds?: string[];
    pendingSteeringMessageIds?: string[];
    providerResumeState?: ProviderResumeState;
    loopState?: JsonValue;
  }): Promise<TurnState> {
    const row = await this.immediateWrite(() => {
      const current = this.one("select * from turn_states where turn_id = ? limit 1", [input.turnId]);
      const currentState = current ? turnStateSchema.parse(rowToTurnState(current)) : undefined;
      const currentCompleted = currentState?.completedToolCallIds ?? [];
      const currentProviderResumeState = currentState?.providerResumeState;
      const timestamp = nowIso();
      const providerResumeStateJson = input.providerResumeState === undefined ? (currentProviderResumeState === undefined ? null : encode(currentProviderResumeState)) : encode(input.providerResumeState);
      const values: SqliteValue[] = [
        input.phase,
        input.activeToolExecutionId ?? null,
        input.activeActivityId ?? null,
        input.contextBuildId ?? null,
        encode(input.pendingToolCalls ?? []),
        encode(input.completedToolCallIds ?? currentCompleted),
        encode(input.pendingInteractionIds ?? []),
        encode(input.pendingSteeringMessageIds ?? []),
        providerResumeStateJson,
        encode(input.loopState ?? {})
      ];
      const id = currentState?.id ?? input.id ?? createId("state");
      if (currentState) {
        this.run(
          "update turn_states set phase = ?, active_tool_execution_id = ?, active_activity_id = ?, context_build_id = ?, pending_tool_calls_json = ?, completed_tool_call_ids_json = ?, pending_interaction_ids_json = ?, pending_steering_message_ids_json = ?, provider_resume_state_json = ?, loop_state_json = ? where id = ?",
          [...values, id]
        );
      } else {
        this.run(
          "insert into turn_states (id, conversation_id, turn_id, phase, active_tool_execution_id, active_activity_id, context_build_id, pending_tool_calls_json, completed_tool_call_ids_json, pending_interaction_ids_json, pending_steering_message_ids_json, provider_resume_state_json, loop_state_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            input.conversationId,
            input.turnId,
            ...values,
            timestamp
          ]
        );
      }
      if (input.providerResumeState !== undefined) {
        this.run("update conversations set provider_resume_state_json = ?, updated_at = ? where id = ?", [
          encode(input.providerResumeState),
          timestamp,
          input.conversationId
        ]);
      }
      return this.one("select * from turn_states where id = ?", [id]);
    });
    return requireRow(turnStateSchema, row, rowToTurnState);
  }

  public async getTurnState(turnId: string): Promise<TurnState | undefined> {
    const row = this.one("select * from turn_states where turn_id = ? limit 1", [turnId]);
    return row ? requireRow(turnStateSchema, row, rowToTurnState) : undefined;
  }

  public async enqueueConversationInput(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source: ConversationInputSource;
    sourceRef?: SourceRef;
    delivery: "asap" | "after_active" | "manual";
    target: ConversationInputTarget;
    role: MessageRole;
    content: ContentBlock[];
  }): Promise<ConversationInputRecord> {
    const timestamp = nowIso();
    const id = input.id ?? createId("input");
    this.run(
      "insert into conversation_inputs (id, conversation_id, turn_id, source, source_type, source_id, delivery, target, role, content_json, status, consumed_message_id, created_at, consumed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.source,
        input.sourceRef?.type ?? null,
        input.sourceRef?.id ?? null,
        input.delivery,
        input.target,
        input.role,
        encode(input.content),
        "pending",
        null,
        timestamp,
        null
      ]
    );
    return requireRow(conversationInputRecordSchema, this.one("select * from conversation_inputs where id = ?", [id]), rowToConversationInput);
  }

  public async listConversationInputs(input: {
    conversationId: string;
    turnId?: string;
    delivery?: "asap" | "after_active" | "manual";
    status?: ConversationInputStatus;
  }): Promise<ConversationInputRecord[]> {
    const rows = this.all("select * from conversation_inputs where conversation_id = ? order by created_at asc", [input.conversationId]).filter((row) =>
      (input.turnId === undefined || nullableString(row, "turn_id") === input.turnId) &&
      (input.delivery === undefined || stringField(row, "delivery") === input.delivery) &&
      (input.status === undefined || stringField(row, "status") === input.status)
    );
    return rows.map((row) => requireRow(conversationInputRecordSchema, row, rowToConversationInput));
  }

  public async consumeConversationInput(input: { id: string; turnId: string; consumedMessageId: string }): Promise<ConversationInputRecord> {
    const timestamp = nowIso();
    this.run("update conversation_inputs set turn_id = ?, status = ?, consumed_message_id = ?, consumed_at = ? where id = ?", [
      input.turnId,
      "consumed",
      input.consumedMessageId,
      timestamp,
      input.id
    ]);
    return requireRow(conversationInputRecordSchema, this.one("select * from conversation_inputs where id = ?", [input.id]), rowToConversationInput);
  }

  public async cancelConversationInput(id: string): Promise<ConversationInputRecord> {
    this.run("update conversation_inputs set status = ? where id = ?", ["cancelled", id]);
    return requireRow(conversationInputRecordSchema, this.one("select * from conversation_inputs where id = ?", [id]), rowToConversationInput);
  }

  public async createInteractionRequest(input: {
    id?: string;
    conversationId: string;
    turnId: string;
    toolExecutionId?: string;
    activityId?: string;
    origin: InteractionOrigin;
    kind: InteractionKind;
    prompt: ContentBlock[];
    requestedSchema?: JsonValue;
    render?: InteractionRequest["render"];
  }): Promise<InteractionRequest> {
    const timestamp = nowIso();
    const id = input.id ?? createId("intr");
    this.run(
      "insert into interaction_requests (id, conversation_id, turn_id, tool_execution_id, activity_id, origin, kind, status, prompt_json, requested_schema_json, render_json, response_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId,
        input.turnId,
        input.toolExecutionId ?? null,
        input.activityId ?? null,
        input.origin,
        input.kind,
        "pending",
        encode(input.prompt),
        input.requestedSchema === undefined ? null : encode(input.requestedSchema),
        input.render === undefined ? null : encode(input.render),
        null,
        timestamp,
        timestamp
      ]
    );
    return requireRow(interactionRequestSchema, this.one("select * from interaction_requests where id = ?", [id]), rowToInteraction);
  }

  public async getInteractionRequest(id: string): Promise<InteractionRequest | undefined> {
    const row = this.one("select * from interaction_requests where id = ?", [id]);
    return row ? requireRow(interactionRequestSchema, row, rowToInteraction) : undefined;
  }

  public async listInteractionRequests(conversationId?: string): Promise<InteractionRequest[]> {
    const rows = conversationId
      ? this.all("select * from interaction_requests where conversation_id = ? order by created_at asc", [conversationId])
      : this.all("select * from interaction_requests order by created_at asc", []);
    return rows.map((row) => requireRow(interactionRequestSchema, row, rowToInteraction));
  }

  public async listPendingInteractions(conversationId?: string): Promise<InteractionRequest[]> {
    const rows = conversationId
      ? this.all("select * from interaction_requests where conversation_id = ? and status = 'pending' order by created_at asc", [conversationId])
      : this.all("select * from interaction_requests where status = 'pending' order by created_at asc", []);
    return rows.map((row) => requireRow(interactionRequestSchema, row, rowToInteraction));
  }

  public async updateInteractionRequest(input: { id: string; expectedStatus?: InteractionStatus; status?: InteractionStatus; response?: JsonValue }): Promise<InteractionRequest> {
    const current = await this.getInteractionRequest(input.id);
    if (!current) {
      throw new Error(`Interaction ${input.id} not found`);
    }
    const timestamp = nowIso();
    const params: SqliteValue[] = [
      input.status ?? current.status,
      input.response === undefined ? (current.response === undefined ? null : encode(current.response)) : encode(input.response),
      timestamp,
      input.id
    ];
    const info = input.expectedStatus === undefined
      ? this.run("update interaction_requests set status = ?, response_json = ?, updated_at = ? where id = ?", params)
      : this.run("update interaction_requests set status = ?, response_json = ?, updated_at = ? where id = ? and status = ?", [...params, input.expectedStatus]);
    if (info.changes === 0) {
      const latest = await this.getInteractionRequest(input.id);
      throw new Error(`Interaction ${input.id} expected status ${input.expectedStatus ?? current.status} but was ${latest?.status ?? "missing"}`);
    }
    return requireRow(interactionRequestSchema, this.one("select * from interaction_requests where id = ?", [input.id]), rowToInteraction);
  }

  public async createContextBlock(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    kind: ContextBlockKind;
    content?: ContentBlock[];
    data?: JsonValue;
    metadata?: Record<string, JsonValue>;
    coverageCursor?: string;
    policyId?: string;
    sourceContextBuildId?: string;
  }): Promise<ContextBlock> {
    const timestamp = nowIso();
    const id = input.id ?? createId("ctxb");
    this.run(
      "insert into context_blocks (id, conversation_id, turn_id, source_type, source_id, kind, content_json, data_json, metadata_json, coverage_cursor, policy_id, source_context_build_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.source?.type ?? null,
        input.source?.id ?? null,
        input.kind,
        encode(input.content ?? []),
        input.data === undefined ? null : encode(input.data),
        encode(input.metadata ?? {}),
        input.coverageCursor ?? null,
        input.policyId ?? null,
        input.sourceContextBuildId ?? null,
        timestamp
      ]
    );
    return requireRow(contextBlockSchema, this.one("select * from context_blocks where id = ?", [id]), rowToContextBlock);
  }

  public async getContextBlock(id: string): Promise<ContextBlock | undefined> {
    const row = this.one("select * from context_blocks where id = ?", [id]);
    return row ? requireRow(contextBlockSchema, row, rowToContextBlock) : undefined;
  }

  public async listContextBlocks(conversationId: string, input?: { turnId?: string; kind?: ContextBlockKind }): Promise<ContextBlock[]> {
    const rows = input?.turnId && input.kind
      ? this.all("select * from context_blocks where conversation_id = ? and turn_id = ? and kind = ? order by created_at asc", [conversationId, input.turnId, input.kind])
      : input?.turnId
        ? this.all("select * from context_blocks where conversation_id = ? and turn_id = ? order by created_at asc", [conversationId, input.turnId])
        : input?.kind
          ? this.all("select * from context_blocks where conversation_id = ? and kind = ? order by created_at asc", [conversationId, input.kind])
          : this.all("select * from context_blocks where conversation_id = ? order by created_at asc", [conversationId]);
    return rows.map((row) => requireRow(contextBlockSchema, row, rowToContextBlock));
  }

  public async createContextBlockSource(input: {
    blockId: string;
    sourceKind: string;
    sourceId?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBlockSource> {
    const timestamp = nowIso();
    this.run("insert into context_block_sources (block_id, source_kind, source_id, metadata_json, created_at) values (?, ?, ?, ?, ?)", [
      input.blockId,
      input.sourceKind,
      input.sourceId ?? null,
      encode(input.metadata ?? {}),
      timestamp
    ]);
    return contextBlockSourceSchema.parse({
      blockId: input.blockId,
      sourceKind: input.sourceKind,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      metadata: input.metadata ?? {},
      createdAt: timestamp
    });
  }

  public async listContextBlockSources(blockId: string): Promise<ContextBlockSource[]> {
    return this.all("select * from context_block_sources where block_id = ? order by created_at asc", [blockId]).map((row) =>
      requireRow(contextBlockSourceSchema, row, rowToContextBlockSource)
    );
  }

  public async createContextModelMetadata(input: {
    id?: string;
    blockId: string;
    provider: string;
    modelId: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextModelMetadata> {
    const timestamp = nowIso();
    const id = input.id ?? createId("ctxm");
    this.run("insert into context_model_metadata (id, block_id, provider, model_id, metadata_json, created_at) values (?, ?, ?, ?, ?, ?)", [
      id,
      input.blockId,
      input.provider,
      input.modelId,
      encode(input.metadata ?? {}),
      timestamp
    ]);
    return requireRow(contextModelMetadataSchema, this.one("select * from context_model_metadata where id = ?", [id]), rowToContextModelMetadata);
  }

  public async listContextModelMetadata(blockId?: string): Promise<ContextModelMetadata[]> {
    const rows = blockId
      ? this.all("select * from context_model_metadata where block_id = ? order by created_at asc", [blockId])
      : this.all("select * from context_model_metadata order by created_at asc", []);
    return rows.map((row) => requireRow(contextModelMetadataSchema, row, rowToContextModelMetadata));
  }

  public async createContextBuild(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    modelConfig: ModelConfig;
    policyId: string;
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextBuild> {
    modelConfigSchema.parse(input.modelConfig);
    const timestamp = nowIso();
    const id = input.id ?? createId("ctxbuild");
    this.run("insert into context_builds (id, conversation_id, turn_id, model_config_json, policy_id, diagnostics_json, created_at) values (?, ?, ?, ?, ?, ?, ?)", [
      id,
      input.conversationId,
      input.turnId ?? null,
      encode(input.modelConfig),
      input.policyId,
      encode(input.diagnostics ?? {}),
      timestamp
    ]);
    return requireRow(contextBuildSchema, this.one("select * from context_builds where id = ?", [id]), rowToContextBuild);
  }

  public async getContextBuild(id: string): Promise<ContextBuild | undefined> {
    const row = this.one("select * from context_builds where id = ?", [id]);
    return row ? requireRow(contextBuildSchema, row, rowToContextBuild) : undefined;
  }

  public async listContextBuilds(conversationId: string): Promise<ContextBuild[]> {
    return this.all("select * from context_builds where conversation_id = ? order by created_at asc", [conversationId]).map((row) =>
      requireRow(contextBuildSchema, row, rowToContextBuild)
    );
  }

  public async addContextBuildItem(input: {
    contextBuildId: string;
    blockId: string;
    sequence: number;
    role?: MessageRole;
    tokenEstimate?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBuildItem> {
    this.run("insert into context_build_items (context_build_id, block_id, sequence, role, token_estimate, metadata_json) values (?, ?, ?, ?, ?, ?)", [
      input.contextBuildId,
      input.blockId,
      input.sequence,
      input.role ?? null,
      input.tokenEstimate ?? null,
      encode(input.metadata ?? {})
    ]);
    return requireRow(
      contextBuildItemSchema,
      this.one("select * from context_build_items where context_build_id = ? and sequence = ?", [input.contextBuildId, input.sequence]),
      rowToContextBuildItem
    );
  }

  public async listContextBuildItems(contextBuildId: string): Promise<ContextBuildItem[]> {
    return this.all("select * from context_build_items where context_build_id = ? order by sequence asc", [contextBuildId]).map((row) =>
      requireRow(contextBuildItemSchema, row, rowToContextBuildItem)
    );
  }

  public async createToolExecution(input: {
    id?: string;
    conversationId: string;
    turnId: string;
    requestMessageId?: string;
    contextBuildId?: string;
    toolCallId: string;
    toolName: string;
    input: JsonValue;
    status?: ToolExecutionStatus;
    pendingInteractionIds?: string[];
    resumeState?: JsonValue;
    result?: ToolResult;
    createdActivityIds?: string[];
  }): Promise<ToolExecutionRecord> {
    const existing = await this.getToolExecutionByTurnAndToolCallId(input.turnId, input.toolCallId);
    if (existing) {
      throw new Error(`Turn ${input.turnId} already has a tool execution for call ${input.toolCallId}`);
    }
    const timestamp = nowIso();
    const id = input.id ?? createId("toolexec");
    this.run(
      "insert into tool_executions (id, conversation_id, turn_id, request_message_id, context_build_id, tool_call_id, tool_name, input_json, status, pending_interaction_ids_json, resume_state_json, result_json, created_activity_ids_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.conversationId,
        input.turnId,
        input.requestMessageId ?? null,
        input.contextBuildId ?? null,
        input.toolCallId,
        input.toolName,
        encode(input.input),
        input.status ?? "running",
        encode(input.pendingInteractionIds ?? []),
        input.resumeState === undefined ? null : encode(input.resumeState),
        input.result === undefined ? null : encode(input.result),
        encode(input.createdActivityIds ?? []),
        timestamp,
        timestamp
      ]
    );
    return requireRow(toolExecutionRecordSchema, this.one("select * from tool_executions where id = ?", [id]), rowToToolExecution);
  }

  public async updateToolExecution(input: {
    id: string;
    status?: ToolExecutionStatus;
    pendingInteractionIds?: string[];
    resumeState?: JsonValue;
    result?: ToolResult;
    createdActivityIds?: string[];
  }): Promise<ToolExecutionRecord> {
    const current = await this.getToolExecution(input.id);
    if (!current) {
      throw new Error(`ToolExecution ${input.id} not found`);
    }
    const timestamp = nowIso();
    this.run(
      "update tool_executions set status = ?, pending_interaction_ids_json = ?, resume_state_json = ?, result_json = ?, created_activity_ids_json = ?, updated_at = ? where id = ?",
      [
        input.status ?? current.status,
        input.pendingInteractionIds !== undefined ? encode(input.pendingInteractionIds) : encode(current.pendingInteractionIds),
        input.resumeState !== undefined ? encode(input.resumeState) : (current.resumeState === undefined ? null : encode(current.resumeState)),
        input.result !== undefined ? encode(input.result) : (current.result === undefined ? null : encode(current.result)),
        input.createdActivityIds !== undefined ? encode(input.createdActivityIds) : encode(current.createdActivityIds),
        timestamp,
        input.id
      ]
    );
    return requireRow(toolExecutionRecordSchema, this.one("select * from tool_executions where id = ?", [input.id]), rowToToolExecution);
  }

  public async getToolExecution(id: string): Promise<ToolExecutionRecord | undefined> {
    const row = this.one("select * from tool_executions where id = ?", [id]);
    return row ? requireRow(toolExecutionRecordSchema, row, rowToToolExecution) : undefined;
  }

  public async getToolExecutionByTurnAndToolCallId(turnId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined> {
    const row = this.one("select * from tool_executions where turn_id = ? and tool_call_id = ?", [turnId, toolCallId]);
    return row ? requireRow(toolExecutionRecordSchema, row, rowToToolExecution) : undefined;
  }

  public async listToolExecutions(conversationId: string): Promise<ToolExecutionRecord[]> {
    return this.all("select * from tool_executions where conversation_id = ? order by created_at asc", [conversationId]).map((row) =>
      requireRow(toolExecutionRecordSchema, row, rowToToolExecution)
    );
  }

  public async finalizeToolExecution(input: {
    conversationId: string;
    turnId: string;
    toolExecutionId: string;
    call: ToolCall;
    status: ToolExecutionStatus;
    result: ToolResult;
  }): Promise<{ execution: ToolExecutionRecord; message: MessageRecord; resultBlock: ContextBlock; fileReadBlock?: ContextBlock; event: HarnessEvent }> {
    const rows = await this.immediateWrite(() => {
      const executionRow = this.one("select * from tool_executions where id = ?", [input.toolExecutionId]);
      if (!executionRow) {
        throw new Error(`ToolExecution ${input.toolExecutionId} not found`);
      }
      const execution = requireRow(toolExecutionRecordSchema, executionRow, rowToToolExecution);
      if (execution.conversationId !== input.conversationId || execution.turnId !== input.turnId || execution.toolCallId !== input.call.id) {
        throw new Error(`ToolExecution ${input.toolExecutionId} does not match call ${input.call.id}`);
      }
      if (input.result.toolCallId !== input.call.id) {
        throw new Error(`Tool result ${input.result.toolCallId} does not match call ${input.call.id}`);
      }

      const existingMessage = this.one(
        "select * from messages where conversation_id = ? and turn_id = ? and role = 'tool' and source_type = 'tool_execution' and source_id = ? order by sequence asc limit 1",
        [input.conversationId, input.turnId, input.toolExecutionId]
      );
      if (existingMessage) {
        if (execution.status !== input.status || !jsonEqual(execution.result, input.result)) {
          throw new Error(`ToolExecution ${input.toolExecutionId} was already finalized differently`);
        }
        const resultBlock = this.one(
          "select * from context_blocks where conversation_id = ? and turn_id = ? and source_type = 'tool_execution' and source_id = ? and kind = 'tool_result' order by created_at asc limit 1",
          [input.conversationId, input.turnId, input.toolExecutionId]
        );
        if (!resultBlock) {
          throw new Error(`ToolExecution ${input.toolExecutionId} is missing tool_result context block`);
        }
        const event = this.one(
          "select * from events where conversation_id = ? and turn_id = ? and source_type = 'tool_execution' and source_id = ? and type = 'tool.completed' order by sequence asc limit 1",
          [input.conversationId, input.turnId, input.toolExecutionId]
        );
        if (!event) {
          throw new Error(`ToolExecution ${input.toolExecutionId} is missing completion event`);
        }
        return {
          executionRow,
          messageRow: existingMessage,
          resultBlockRow: resultBlock,
          fileReadBlockRow: this.one(
            "select * from context_blocks where conversation_id = ? and turn_id = ? and source_type = 'tool_execution' and source_id = ? and kind = 'file_read' order by created_at asc limit 1",
            [input.conversationId, input.turnId, input.toolExecutionId]
          ),
          eventRow: event
        };
      }

      if (isTerminalToolExecutionStatus(execution.status) && execution.result !== undefined && (execution.status !== input.status || !jsonEqual(execution.result, input.result))) {
        throw new Error(`ToolExecution ${input.toolExecutionId} was already finalized differently`);
      }

      const timestamp = nowIso();
      this.run("update tool_executions set status = ?, result_json = ?, updated_at = ? where id = ?", [
        input.status,
        encode(input.result),
        timestamp,
        input.toolExecutionId
      ]);

      const messageSequence = numberField(requiredRowObject(this.one("select coalesce(max(sequence), -1) + 1 as next_sequence from messages where conversation_id = ?", [input.conversationId])), "next_sequence");
      const messageId = createId("msg");
      this.run(
        "insert into messages (id, conversation_id, sequence, turn_id, role, content_json, source_type, source_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          messageId,
          input.conversationId,
          messageSequence,
          input.turnId,
          "tool",
          encode([
            ...input.result.content,
            { type: "tool_result_ref", toolCallId: input.call.id, toolExecutionId: input.toolExecutionId, status: input.result.status }
          ]),
          "tool_execution",
          input.toolExecutionId,
          timestamp
        ]
      );

      const resultBlockId = createId("ctxb");
      this.run(
        "insert into context_blocks (id, conversation_id, turn_id, source_type, source_id, kind, content_json, data_json, metadata_json, coverage_cursor, policy_id, source_context_build_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          resultBlockId,
          input.conversationId,
          input.turnId,
          "tool_execution",
          input.toolExecutionId,
          "tool_result",
          encode(input.result.content),
          encode({
            toolCallId: input.call.id,
            status: input.result.status,
            summary: input.result.summary,
            resultData: input.result.data ?? null
          }),
          encode({}),
          null,
          null,
          null,
          timestamp
        ]
      );

      let fileReadBlockId: string | undefined;
      if (input.call.name === "read_file" && isObject(input.result.data) && typeof input.result.data.path === "string") {
        fileReadBlockId = createId("ctxb");
        this.run(
          "insert into context_blocks (id, conversation_id, turn_id, source_type, source_id, kind, content_json, data_json, metadata_json, coverage_cursor, policy_id, source_context_build_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            fileReadBlockId,
            input.conversationId,
            input.turnId,
            "tool_execution",
            input.toolExecutionId,
            "file_read",
            encode(input.result.content),
            encode(input.result.data),
            encode({ path: input.result.data.path }),
            null,
            null,
            null,
            timestamp
          ]
        );
      }

      const eventId = createId("evt");
      const eventInfo = this.run("insert into events (id, conversation_id, turn_id, source_type, source_id, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [
        eventId,
        input.conversationId,
        input.turnId,
        "tool_execution",
        input.toolExecutionId,
        "tool.completed",
        encode({ toolExecutionId: input.toolExecutionId, toolCallId: input.result.toolCallId, status: input.result.status, summary: input.result.summary }),
        timestamp
      ]);

      return {
        executionRow: this.one("select * from tool_executions where id = ?", [input.toolExecutionId]),
        messageRow: this.one("select * from messages where id = ?", [messageId]),
        resultBlockRow: this.one("select * from context_blocks where id = ?", [resultBlockId]),
        fileReadBlockRow: fileReadBlockId ? this.one("select * from context_blocks where id = ?", [fileReadBlockId]) : undefined,
        eventRow: this.one("select * from events where sequence = ?", [Number(eventInfo.lastInsertRowid)])
      };
    });

    const execution = requireRow(toolExecutionRecordSchema, rows.executionRow, rowToToolExecution);
    const message = requireRow(messageRecordSchema, rows.messageRow, rowToMessage);
    const resultBlock = requireRow(contextBlockSchema, rows.resultBlockRow, rowToContextBlock);
    const fileReadBlock = rows.fileReadBlockRow ? requireRow(contextBlockSchema, rows.fileReadBlockRow, rowToContextBlock) : undefined;
    const event = requireRow(harnessEventSchema, rows.eventRow, rowToEvent);
    return { execution, message, resultBlock, ...(fileReadBlock ? { fileReadBlock } : {}), event };
  }

  public async getPluginKv(namespace: string, key: string): Promise<JsonValue | undefined> {
    const row = this.one("select * from plugin_kv where namespace = ? and key = ?", [namespace, key]);
    return row ? decodeJson(stringField(row, "value_json")) : undefined;
  }

  public async setPluginKv(namespace: string, key: string, value: JsonValue): Promise<void> {
    const timestamp = nowIso();
    this.run(
      "insert into plugin_kv (namespace, key, value_json, updated_at) values (?, ?, ?, ?) on conflict(namespace, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at",
      [namespace, key, encode(value), timestamp]
    );
  }

  private one(sql: string, params: SqliteValue[]): Record<string, unknown> | undefined {
    return this.sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }

  private all(sql: string, params: SqliteValue[]): Record<string, unknown>[] {
    return this.sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  private run(sql: string, params: SqliteValue[]): Database.RunResult {
    return this.sqlite.prepare(sql).run(...params);
  }

  private async immediateWrite<T>(operation: () => T): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        this.sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = operation();
          this.sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            this.sqlite.exec("ROLLBACK");
          } catch {
            // Ignore rollback errors; the original write error is the actionable failure.
          }
          throw error;
        }
      } catch (error) {
        attempt += 1;
        if (!isRetryableSqliteWriteError(error) || attempt >= this.writeRetryAttempts) {
          throw error;
        }
        await delay(this.writeRetryDelayMs * attempt);
      }
    }
  }
}

export async function openSqliteHarnessStore(options: SqliteHarnessStoreOptions): Promise<SqliteHarnessStore> {
  return SqliteHarnessStore.open(options);
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decodeJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSqliteWriteError(error: unknown): boolean {
  return isObject(error) &&
    typeof error.code === "string" &&
    ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"].includes(error.code);
}

function isTerminalToolExecutionStatus(status: ToolExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireRow<T>(schemaParser: { parse(input: unknown): T }, row: Record<string, unknown> | undefined, mapper: (row: Record<string, unknown>) => unknown): T {
  if (!row) {
    throw new Error("Expected SQLite row was not found");
  }
  return schemaParser.parse(mapper(row));
}

function requiredRowObject(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) {
    throw new Error("Expected SQLite aggregate row was not found");
  }
  return row;
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
    parentConversationId: nullableString(row, "parent_conversation_id"),
    profileId: nullableString(row, "profile_id"),
    effectiveProfile: effectiveProfileSchema.parse(JSON.parse(stringField(row, "effective_profile_json"))),
    executionContextId: nullableString(row, "execution_context_id"),
    providerResumeState: nullableJson(row, "provider_resume_state_json"),
    title: nullableString(row, "title"),
    status: stringField(row, "status"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToTurn(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    parentTurnId: nullableString(row, "parent_turn_id"),
    status: stringField(row, "status"),
    inputMessageIds: JSON.parse(stringField(row, "input_message_ids_json")),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToMessage(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    sequence: numberField(row, "sequence"),
    turnId: nullableString(row, "turn_id"),
    role: stringField(row, "role"),
    content: JSON.parse(stringField(row, "content_json")),
    source: rowToSourceRef(row),
    createdAt: stringField(row, "created_at")
  });
}

function rowToActivity(row: Record<string, unknown>): unknown {
  const activityStateJson = nullableString(row, "activity_state_json");
  const resultJson = nullableString(row, "result_json");
  const onCompletionJson = nullableString(row, "on_completion_json");
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    parentActivityId: nullableString(row, "parent_activity_id"),
    ownerPluginId: stringField(row, "owner_plugin_id"),
    kind: stringField(row, "kind"),
    label: stringField(row, "label"),
    status: stringField(row, "status"),
    cancellable: booleanField(row, "cancellable"),
    activityState: activityStateJson === undefined ? undefined : JSON.parse(activityStateJson),
    result: resultJson === undefined ? undefined : JSON.parse(resultJson),
    onCompletion: onCompletionJson === undefined ? undefined : JSON.parse(onCompletionJson),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToSourceRef(row: Record<string, unknown>, typeKey = "source_type", idKey = "source_id"): SourceRef | undefined {
  const type = nullableString(row, typeKey);
  if (!type) {
    return undefined;
  }
  return {
    type: type as SourceRef["type"],
    id: nullableString(row, idKey)
  };
}

function rowToEvent(row: Record<string, unknown>): unknown {
  return compact({
    sequence: numberField(row, "sequence"),
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    source: rowToSourceRef(row),
    type: stringField(row, "type"),
    payload: JSON.parse(stringField(row, "payload_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToAsset(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: nullableString(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    source: rowToSourceRef(row),
    messageId: nullableString(row, "message_id"),
    uri: stringField(row, "uri"),
    mimeType: stringField(row, "mime_type"),
    byteSize: numberField(row, "byte_size"),
    sha256: nullableString(row, "sha256"),
    origin: JSON.parse(stringField(row, "origin_json")),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    derivedFromAssetId: nullableString(row, "derived_from_asset_id"),
    createdAt: stringField(row, "created_at")
  });
}

function rowToArtifact(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    source: rowToSourceRef(row),
    kind: stringField(row, "kind"),
    uri: nullableString(row, "uri"),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToStateNamespace(row: Record<string, unknown>): unknown {
  return {
    conversationId: stringField(row, "conversation_id"),
    namespace: stringField(row, "namespace"),
    value: JSON.parse(stringField(row, "value_json")),
    version: numberField(row, "version"),
    updatedAt: stringField(row, "updated_at")
  };
}

function rowToWorkspace(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    kind: stringField(row, "kind"),
    rootPath: nullableString(row, "root_path"),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToExecutionContext(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: nullableString(row, "conversation_id"),
    workspaceId: nullableString(row, "workspace_id"),
    providerKind: stringField(row, "provider_kind"),
    cwd: nullableString(row, "cwd"),
    env: JSON.parse(stringField(row, "env_json")),
    providerConfig: nullableJson(row, "provider_config_json"),
    status: stringField(row, "status"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToTurnState(row: Record<string, unknown>): TurnState {
  return turnStateSchema.parse(compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: stringField(row, "turn_id"),
    phase: stringField(row, "phase"),
    activeToolExecutionId: nullableString(row, "active_tool_execution_id"),
    activeActivityId: nullableString(row, "active_activity_id"),
    contextBuildId: nullableString(row, "context_build_id"),
    pendingToolCalls: JSON.parse(stringField(row, "pending_tool_calls_json")).map((call: unknown) => toolCallSchema.parse(call)),
    completedToolCallIds: JSON.parse(stringField(row, "completed_tool_call_ids_json")),
    pendingInteractionIds: JSON.parse(stringField(row, "pending_interaction_ids_json")),
    pendingSteeringMessageIds: JSON.parse(stringField(row, "pending_steering_message_ids_json")),
    providerResumeState: nullableJson(row, "provider_resume_state_json"),
    loopState: JSON.parse(stringField(row, "loop_state_json")),
    createdAt: stringField(row, "created_at")
  }));
}

function rowToConversationInput(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    source: stringField(row, "source"),
    sourceRef: rowToSourceRef(row),
    delivery: stringField(row, "delivery"),
    target: stringField(row, "target"),
    role: stringField(row, "role"),
    content: JSON.parse(stringField(row, "content_json")),
    status: stringField(row, "status"),
    consumedMessageId: nullableString(row, "consumed_message_id"),
    createdAt: stringField(row, "created_at"),
    consumedAt: nullableString(row, "consumed_at")
  });
}

function rowToInteraction(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: stringField(row, "turn_id"),
    toolExecutionId: nullableString(row, "tool_execution_id"),
    activityId: nullableString(row, "activity_id"),
    origin: stringField(row, "origin"),
    kind: stringField(row, "kind"),
    status: stringField(row, "status"),
    prompt: JSON.parse(stringField(row, "prompt_json")),
    requestedSchema: nullableJson(row, "requested_schema_json"),
    render: nullableJson(row, "render_json"),
    response: nullableJson(row, "response_json"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  });
}

function rowToContextBlock(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    source: rowToSourceRef(row),
    kind: stringField(row, "kind"),
    content: JSON.parse(stringField(row, "content_json")),
    data: nullableJson(row, "data_json"),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    coverageCursor: nullableString(row, "coverage_cursor"),
    policyId: nullableString(row, "policy_id"),
    sourceContextBuildId: nullableString(row, "source_context_build_id"),
    createdAt: stringField(row, "created_at")
  });
}

function rowToToolExecution(row: Record<string, unknown>): ToolExecutionRecord {
  return toolExecutionRecordSchema.parse(compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: stringField(row, "turn_id"),
    requestMessageId: nullableString(row, "request_message_id"),
    contextBuildId: nullableString(row, "context_build_id"),
    toolCallId: stringField(row, "tool_call_id"),
    toolName: stringField(row, "tool_name"),
    input: JSON.parse(stringField(row, "input_json")),
    status: stringField(row, "status"),
    pendingInteractionIds: JSON.parse(stringField(row, "pending_interaction_ids_json")),
    resumeState: nullableJson(row, "resume_state_json"),
    result: nullableJson(row, "result_json"),
    createdActivityIds: JSON.parse(stringField(row, "created_activity_ids_json")),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at")
  }));
}

function rowToContextBlockSource(row: Record<string, unknown>): unknown {
  return compact({
    blockId: stringField(row, "block_id"),
    sourceKind: stringField(row, "source_kind"),
    sourceId: nullableString(row, "source_id"),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToContextModelMetadata(row: Record<string, unknown>): unknown {
  return {
    id: stringField(row, "id"),
    blockId: stringField(row, "block_id"),
    provider: stringField(row, "provider"),
    modelId: stringField(row, "model_id"),
    metadata: JSON.parse(stringField(row, "metadata_json")),
    createdAt: stringField(row, "created_at")
  };
}

function rowToContextBuild(row: Record<string, unknown>): unknown {
  return compact({
    id: stringField(row, "id"),
    conversationId: stringField(row, "conversation_id"),
    turnId: nullableString(row, "turn_id"),
    modelConfig: JSON.parse(stringField(row, "model_config_json")),
    policyId: stringField(row, "policy_id"),
    diagnostics: JSON.parse(stringField(row, "diagnostics_json")),
    createdAt: stringField(row, "created_at")
  });
}

function rowToContextBuildItem(row: Record<string, unknown>): unknown {
  return compact({
    contextBuildId: stringField(row, "context_build_id"),
    blockId: stringField(row, "block_id"),
    sequence: numberField(row, "sequence"),
    role: nullableString(row, "role"),
    tokenEstimate: nullableNumber(row, "token_estimate"),
    metadata: JSON.parse(stringField(row, "metadata_json"))
  });
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function nullableString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a nullable string`);
  }
  return value;
}

function nullableJson(row: Record<string, unknown>, key: string): JsonValue | undefined {
  const value = nullableString(row, key);
  return value === undefined ? undefined : JSON.parse(value) as JsonValue;
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected ${key} to be a number`);
  }
  return value;
}

function nullableNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`Expected ${key} to be a nullable number`);
  }
  return value;
}

function booleanField(row: Record<string, unknown>, key: string): boolean {
  return numberField(row, key) !== 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
