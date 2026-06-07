import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    configJson: text("config_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("profiles_name_unique").on(table.name)]
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    parentConversationId: text("parent_conversation_id"),
    profileId: text("profile_id"),
    effectiveProfileJson: text("effective_profile_json").notNull(),
    executionContextId: text("execution_context_id"),
    providerResumeStateJson: text("provider_resume_state_json"),
    title: text("title"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("conversations_parent_idx").on(table.parentConversationId),
    index("conversations_profile_idx").on(table.profileId),
    index("conversations_execution_context_idx").on(table.executionContextId)
  ]
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    parentTurnId: text("parent_turn_id"),
    status: text("status").notNull(),
    inputMessageIdsJson: text("input_message_ids_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("turns_conversation_idx").on(table.conversationId),
    index("turns_status_idx").on(table.status),
    uniqueIndex("turns_one_active_per_conversation_unique")
      .on(table.conversationId)
      .where(sql`status in ('running', 'waiting')`)
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sequence: integer("sequence").notNull(),
    turnId: text("turn_id"),
    role: text("role").notNull(),
    contentJson: text("content_json").notNull(),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("messages_conversation_sequence_unique").on(table.conversationId, table.sequence),
    index("messages_conversation_sequence_idx").on(table.conversationId, table.sequence),
    index("messages_turn_idx").on(table.turnId),
    index("messages_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    parentActivityId: text("parent_activity_id"),
    ownerPluginId: text("owner_plugin_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull(),
    cancellable: integer("cancellable").notNull(),
    activityStateJson: text("activity_state_json"),
    resultJson: text("result_json"),
    onCompletionJson: text("on_completion_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("activities_conversation_idx").on(table.conversationId),
    index("activities_turn_idx").on(table.turnId),
    index("activities_parent_idx").on(table.parentActivityId)
  ]
);

export const events = sqliteTable(
  "events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("events_id_unique").on(table.id),
    index("events_conversation_sequence_idx").on(table.conversationId, table.sequence),
    index("events_turn_sequence_idx").on(table.turnId, table.sequence),
    index("events_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    turnId: text("turn_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    messageId: text("message_id"),
    uri: text("uri").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256"),
    originJson: text("origin_json").notNull(),
    metadataJson: text("metadata_json").notNull(),
    derivedFromAssetId: text("derived_from_asset_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("assets_conversation_idx").on(table.conversationId),
    index("assets_turn_idx").on(table.turnId),
    index("assets_source_idx").on(table.sourceType, table.sourceId),
    index("assets_message_idx").on(table.messageId)
  ]
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    kind: text("kind").notNull(),
    uri: text("uri"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("artifacts_conversation_idx").on(table.conversationId),
    index("artifacts_turn_idx").on(table.turnId),
    index("artifacts_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const stateNamespaces = sqliteTable(
  "state_namespaces",
  {
    conversationId: text("conversation_id").notNull(),
    namespace: text("namespace").notNull(),
    valueJson: text("value_json").notNull(),
    version: integer("version").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.namespace] })]
);

export const interactionRequests = sqliteTable(
  "interaction_requests",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    toolExecutionId: text("tool_execution_id"),
    activityId: text("activity_id"),
    origin: text("origin").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    promptJson: text("prompt_json").notNull(),
    requestedSchemaJson: text("requested_schema_json"),
    renderJson: text("render_json"),
    responseJson: text("response_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("interaction_requests_conversation_idx").on(table.conversationId),
    index("interaction_requests_turn_idx").on(table.turnId),
    index("interaction_requests_status_idx").on(table.status),
    index("interaction_requests_tool_execution_idx").on(table.toolExecutionId)
  ]
);

export const turnStates = sqliteTable(
  "turn_states",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    phase: text("phase").notNull(),
    activeToolExecutionId: text("active_tool_execution_id"),
    activeActivityId: text("active_activity_id"),
    contextBuildId: text("context_build_id"),
    pendingToolCallsJson: text("pending_tool_calls_json").notNull(),
    completedToolCallIdsJson: text("completed_tool_call_ids_json").notNull(),
    pendingInteractionIdsJson: text("pending_interaction_ids_json").notNull(),
    pendingSteeringMessageIdsJson: text("pending_steering_message_ids_json").notNull(),
    providerResumeStateJson: text("provider_resume_state_json"),
    loopStateJson: text("loop_state_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("turn_states_turn_unique").on(table.turnId),
    index("turn_states_conversation_idx").on(table.conversationId)
  ]
);

export const contextBlocks = sqliteTable(
  "context_blocks",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    kind: text("kind").notNull(),
    contentJson: text("content_json").notNull(),
    dataJson: text("data_json"),
    metadataJson: text("metadata_json").notNull(),
    coverageCursor: text("coverage_cursor"),
    policyId: text("policy_id"),
    sourceContextBuildId: text("source_context_build_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("context_blocks_conversation_idx").on(table.conversationId),
    index("context_blocks_turn_idx").on(table.turnId),
    index("context_blocks_kind_idx").on(table.kind),
    index("context_blocks_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const conversationInputs = sqliteTable(
  "conversation_inputs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    source: text("source").notNull(),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    delivery: text("delivery").notNull(),
    target: text("target").notNull(),
    role: text("role").notNull(),
    contentJson: text("content_json").notNull(),
    status: text("status").notNull(),
    consumedMessageId: text("consumed_message_id"),
    createdAt: text("created_at").notNull(),
    consumedAt: text("consumed_at")
  },
  (table) => [
    index("conversation_inputs_conversation_status_idx").on(table.conversationId, table.status),
    index("conversation_inputs_turn_status_idx").on(table.turnId, table.status),
    index("conversation_inputs_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const contextBlockSources = sqliteTable(
  "context_block_sources",
  {
    blockId: text("block_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("context_block_sources_block_idx").on(table.blockId)]
);

export const contextModelMetadata = sqliteTable(
  "context_model_metadata",
  {
    id: text("id").primaryKey(),
    blockId: text("block_id").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("context_model_metadata_block_idx").on(table.blockId),
    index("context_model_metadata_provider_idx").on(table.provider, table.modelId)
  ]
);

export const contextBuilds = sqliteTable(
  "context_builds",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id"),
    modelConfigJson: text("model_config_json").notNull(),
    policyId: text("policy_id").notNull(),
    diagnosticsJson: text("diagnostics_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("context_builds_conversation_idx").on(table.conversationId),
    index("context_builds_turn_idx").on(table.turnId)
  ]
);

export const contextBuildItems = sqliteTable(
  "context_build_items",
  {
    contextBuildId: text("context_build_id").notNull(),
    blockId: text("block_id").notNull(),
    sequence: integer("sequence").notNull(),
    role: text("role"),
    tokenEstimate: integer("token_estimate"),
    metadataJson: text("metadata_json").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.contextBuildId, table.sequence] }),
    index("context_build_items_block_idx").on(table.blockId)
  ]
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  rootPath: text("root_path"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const executionContexts = sqliteTable(
  "execution_contexts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    workspaceId: text("workspace_id"),
    providerKind: text("provider_kind").notNull(),
    cwd: text("cwd"),
    envJson: text("env_json").notNull(),
    providerConfigJson: text("provider_config_json"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("execution_contexts_conversation_idx").on(table.conversationId),
    index("execution_contexts_workspace_idx").on(table.workspaceId)
  ]
);

export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.namespace, table.key] })]
);

export const pluginMigrations = sqliteTable(
  "plugin_migrations",
  {
    pluginId: text("plugin_id").notNull(),
    migrationId: text("migration_id").notNull(),
    appliedAt: text("applied_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.migrationId] })]
);

export const toolExecutions = sqliteTable(
  "tool_executions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: text("turn_id").notNull(),
    requestMessageId: text("request_message_id"),
    contextBuildId: text("context_build_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status").notNull(),
    pendingInteractionIdsJson: text("pending_interaction_ids_json").notNull(),
    resumeStateJson: text("resume_state_json"),
    resultJson: text("result_json"),
    createdActivityIdsJson: text("created_activity_ids_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("tool_executions_conversation_idx").on(table.conversationId),
    index("tool_executions_turn_idx").on(table.turnId),
    index("tool_executions_tool_call_idx").on(table.conversationId, table.toolCallId),
    uniqueIndex("tool_executions_turn_tool_call_unique").on(table.turnId, table.toolCallId)
  ]
);
