import type {
  AgentRunRecord,
  AgentRunStatus,
  ConversationItem,
  ConversationItemClass,
  ConversationItemKind,
  ConversationItemVisibility,
  ConversationRecord,
  ContentBlock,
  ContextBuild,
  ContextProjection,
  JsonValue,
  MessageRole,
  ModelConfig,
  ProfileConfig,
  ProfileRecord,
  ProviderEncoding,
  ProviderEncodingDraft,
  ProviderEventPayload,
  SourceRef
} from "@harness/protocol";

export interface HarnessStore {
  createProfile(input: { id?: string; name: string; config: ProfileConfig }): Promise<ProfileRecord>;
  listProfiles(): Promise<ProfileRecord[]>;
  getProfileByName(name: string): Promise<ProfileRecord | undefined>;
  setDefaultProfileName(name: string): Promise<void>;
  getDefaultProfileName(): Promise<string | undefined>;

  createConversation(input: { id?: string; profileName?: string; config: ProfileConfig; title?: string }): Promise<ConversationRecord>;
  getConversation(id: string): Promise<ConversationRecord | undefined>;
  listConversations(): Promise<ConversationRecord[]>;
  updateConversation(input: { id: string; status?: ConversationRecord["status"]; title?: string }): Promise<ConversationRecord>;

  appendConversationItem(input: {
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
  }): Promise<ConversationItem>;
  listConversationItems(conversationId: string, input?: { after?: number; limit?: number }): Promise<ConversationItem[]>;
  getLatestItemSequence(conversationId: string): Promise<number>;

  createAgentRun(input: {
    id?: string;
    conversationId: string;
    startedThroughItemSequence: number;
    modelConfig: ModelConfig;
  }): Promise<AgentRunRecord>;
  getAgentRun(id: string): Promise<AgentRunRecord | undefined>;
  getActiveAgentRun(conversationId: string): Promise<AgentRunRecord | undefined>;
  listAgentRuns(conversationId: string): Promise<AgentRunRecord[]>;
  updateAgentRun(input: {
    id: string;
    status?: AgentRunStatus;
    completedThroughItemSequence?: number;
    error?: JsonValue;
  }): Promise<AgentRunRecord>;
  commitAssistantResponse(input: {
    conversationId: string;
    runId: string;
    modelConfig: ModelConfig;
    content: ContentBlock[];
    data?: JsonValue;
    providerEvents: ProviderEventPayload[];
    providerEncoding?: ProviderEncodingDraft;
  }): Promise<{
    assistantItem: ConversationItem;
    providerEventItems: ConversationItem[];
    providerEncoding?: ProviderEncoding;
    run: AgentRunRecord;
  }>;

  createContextProjection(input: {
    id?: string;
    conversationId: string;
    itemId: string;
    coversThroughItemSequence: number;
    policyId: string;
    content: ContentBlock[];
    tokenEstimate: number;
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextProjection>;
  listContextProjections(conversationId: string): Promise<ContextProjection[]>;

  createContextBuild(input: {
    id?: string;
    conversationId: string;
    runId: string;
    modelConfig: ModelConfig;
    projectionId?: string;
    selectedItemIds: string[];
    selectedItemSequences: number[];
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextBuild>;
  listContextBuilds(conversationId: string): Promise<ContextBuild[]>;

  createProviderEncoding(input: {
    id?: string;
    conversationId: string;
    itemId: string;
    itemSequence: number;
    provider: string;
    adapter: string;
    modelId: string;
    format: string;
    formatVersion: number;
    payload: JsonValue;
  }): Promise<ProviderEncoding>;
  listProviderEncodingsForItems(input: {
    conversationId: string;
    itemIds: string[];
    provider: string;
    adapter: string;
    modelId: string;
  }): Promise<ProviderEncoding[]>;
}
