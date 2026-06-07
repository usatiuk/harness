import type {
  ActivityRecord,
  ActivityStatus,
  ArtifactRecord,
  AssetOrigin,
  AssetRecord,
  ContentBlock,
  ContextBlock,
  ContextBlockKind,
  ContextBlockSource,
  ContextBuild,
  ContextBuildItem,
  ContextModelMetadata,
  EffectiveProfile,
  ExecutionContextRecord,
  HarnessEvent,
  InteractionKind,
  InteractionOrigin,
  InteractionRequest,
  InteractionStatus,
  JsonValue,
  MessageRecord,
  MessageRole,
  ModelConfig,
  ProfileConfig,
  ProfileRecord,
  ProviderResumeState,
  ConversationRecord,
  ConversationStatus,
  StateNamespaceRecord,
  ToolCall,
  ConversationInputRecord,
  ConversationInputSource,
  ConversationInputStatus,
  ConversationInputTarget,
  TurnState,
  TurnStatePhase,
  TurnRecord,
  TurnStatus,
  WorkspaceRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
  ToolResult,
  SourceRef
} from "@harness/protocol";

export interface PageRequest {
  after?: number;
  limit?: number;
}

export interface HarnessStore {
  createProfile(input: { id?: string; name: string; config: ProfileConfig }): Promise<ProfileRecord>;
  listProfiles(): Promise<ProfileRecord[]>;
  getProfile(id: string): Promise<ProfileRecord | undefined>;
  getProfileByName(name: string): Promise<ProfileRecord | undefined>;
  updateProfile(id: string, config: ProfileConfig): Promise<ProfileRecord>;
  setDefaultProfileId(profileId: string): Promise<void>;
  getDefaultProfileId(): Promise<string | undefined>;

  createConversation(input: {
    id?: string;
    parentConversationId?: string;
    profileId?: string;
    effectiveProfile: EffectiveProfile;
    executionContextId?: string;
    title?: string;
  }): Promise<ConversationRecord>;
  getConversation(id: string): Promise<ConversationRecord | undefined>;
  listConversations(): Promise<ConversationRecord[]>;
  updateConversation(input: {
    id: string;
    status?: ConversationStatus;
    executionContextId?: string;
    effectiveProfile?: EffectiveProfile;
    providerResumeState?: ProviderResumeState;
  }): Promise<ConversationRecord>;

  createTurn(input: {
    id?: string;
    conversationId: string;
    parentTurnId?: string;
    status?: TurnStatus;
    inputMessageIds?: string[];
  }): Promise<TurnRecord>;
  getTurn(id: string): Promise<TurnRecord | undefined>;
  getActiveTurn(conversationId: string): Promise<TurnRecord | undefined>;
  listTurns(conversationId: string): Promise<TurnRecord[]>;
  updateTurn(input: {
    id: string;
    status?: TurnStatus;
    inputMessageIds?: string[];
  }): Promise<TurnRecord>;

  createMessage(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    role: MessageRole;
    content: ContentBlock[];
    source?: SourceRef;
  }): Promise<MessageRecord>;
  listMessages(conversationId: string, input?: { limit?: number }): Promise<MessageRecord[]>;

  createActivity(input: {
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
  }): Promise<ActivityRecord>;
  updateActivity(input: {
    id: string;
    status?: ActivityStatus;
    activityState?: JsonValue;
    result?: JsonValue;
  }): Promise<ActivityRecord>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  listActivities(conversationId: string): Promise<ActivityRecord[]>;

  appendEvent(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    type: string;
    payload: JsonValue;
  }): Promise<HarnessEvent>;
  listEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]>;

  createAsset(input: {
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
  }): Promise<AssetRecord>;
  getAsset(id: string): Promise<AssetRecord | undefined>;
  listAssets(conversationId?: string): Promise<AssetRecord[]>;

  createArtifact(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    kind: string;
    uri?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ArtifactRecord>;
  listArtifacts(conversationId: string): Promise<ArtifactRecord[]>;

  getStateNamespace(conversationId: string, namespace: string): Promise<StateNamespaceRecord | undefined>;
  upsertStateNamespace(input: {
    conversationId: string;
    namespace: string;
    value: JsonValue;
  }): Promise<StateNamespaceRecord>;
  listStateNamespaces(conversationId: string): Promise<StateNamespaceRecord[]>;

  createWorkspace(input: {
    id?: string;
    kind: string;
    rootPath?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<WorkspaceRecord>;
  createExecutionContext(input: {
    id?: string;
    conversationId?: string;
    workspaceId?: string;
    providerKind: string;
    cwd?: string;
    env?: Record<string, string>;
    providerConfig?: JsonValue;
    status?: ExecutionContextRecord["status"];
  }): Promise<ExecutionContextRecord>;
  getExecutionContext(id: string): Promise<ExecutionContextRecord | undefined>;
  listExecutionContexts(conversationId?: string): Promise<ExecutionContextRecord[]>;

  saveTurnState(input: {
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
  }): Promise<TurnState>;
  getTurnState(turnId: string): Promise<TurnState | undefined>;

  enqueueConversationInput(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    source: ConversationInputSource;
    sourceRef?: SourceRef;
    delivery: "asap" | "after_active" | "manual";
    target: ConversationInputTarget;
    role: MessageRole;
    content: ContentBlock[];
  }): Promise<ConversationInputRecord>;
  listConversationInputs(input: {
    conversationId: string;
    turnId?: string;
    delivery?: "asap" | "after_active" | "manual";
    status?: ConversationInputStatus;
  }): Promise<ConversationInputRecord[]>;
  consumeConversationInput(input: { id: string; turnId: string; consumedMessageId: string }): Promise<ConversationInputRecord>;
  cancelConversationInput(id: string): Promise<ConversationInputRecord>;

  createInteractionRequest(input: {
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
  }): Promise<InteractionRequest>;
  getInteractionRequest(id: string): Promise<InteractionRequest | undefined>;
  listInteractionRequests(conversationId?: string): Promise<InteractionRequest[]>;
  listPendingInteractions(conversationId?: string): Promise<InteractionRequest[]>;
  updateInteractionRequest(input: {
    id: string;
    expectedStatus?: InteractionStatus;
    status?: InteractionStatus;
    response?: JsonValue;
  }): Promise<InteractionRequest>;

  createContextBlock(input: {
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
  }): Promise<ContextBlock>;
  getContextBlock(id: string): Promise<ContextBlock | undefined>;
  listContextBlocks(conversationId: string, input?: { turnId?: string; kind?: ContextBlockKind }): Promise<ContextBlock[]>;
  createContextBlockSource(input: {
    blockId: string;
    sourceKind: string;
    sourceId?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBlockSource>;
  listContextBlockSources(blockId: string): Promise<ContextBlockSource[]>;
  createContextModelMetadata(input: {
    id?: string;
    blockId: string;
    provider: string;
    modelId: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextModelMetadata>;
  listContextModelMetadata(blockId?: string): Promise<ContextModelMetadata[]>;
  createContextBuild(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    modelConfig: ModelConfig;
    policyId: string;
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextBuild>;
  getContextBuild(id: string): Promise<ContextBuild | undefined>;
  listContextBuilds(conversationId: string): Promise<ContextBuild[]>;
  addContextBuildItem(input: {
    contextBuildId: string;
    blockId: string;
    sequence: number;
    role?: MessageRole;
    tokenEstimate?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBuildItem>;
  listContextBuildItems(contextBuildId: string): Promise<ContextBuildItem[]>;

  createToolExecution(input: {
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
  }): Promise<ToolExecutionRecord>;
  updateToolExecution(input: {
    id: string;
    status?: ToolExecutionStatus;
    pendingInteractionIds?: string[];
    resumeState?: JsonValue;
    result?: ToolResult;
    createdActivityIds?: string[];
  }): Promise<ToolExecutionRecord>;
  getToolExecution(id: string): Promise<ToolExecutionRecord | undefined>;
  getToolExecutionByTurnAndToolCallId(turnId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined>;
  listToolExecutions(conversationId: string): Promise<ToolExecutionRecord[]>;
  finalizeToolExecution(input: {
    conversationId: string;
    turnId: string;
    toolExecutionId: string;
    call: ToolCall;
    status: ToolExecutionStatus;
    result: ToolResult;
  }): Promise<{
    execution: ToolExecutionRecord;
    message: MessageRecord;
    resultBlock: ContextBlock;
    fileReadBlock?: ContextBlock;
    event: HarnessEvent;
  }>;

  getPluginKv(namespace: string, key: string): Promise<JsonValue | undefined>;
  setPluginKv(namespace: string, key: string, value: JsonValue): Promise<void>;
}

export async function requireConversation(store: HarnessStore, conversationId: string): Promise<ConversationRecord> {
  const conversation = await store.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  return conversation;
}
