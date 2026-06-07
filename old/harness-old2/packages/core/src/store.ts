import type {
    AgentRunRecord,
    AgentRunStatus,
    ConversationItem,
    ConversationItemInput,
    ConversationRecord,
    ContentBlock,
    ContextBuild,
    ModelAccounting,
    ModelConfig,
    ProfileConfig,
    ProfileRecord,
    ProviderPayload,
    ProviderPayloadDraft,
    ProviderResponse,
} from "@harness/protocol";
import type { JSONType } from "zod";

export interface HarnessStore {
    createProfile(input: {
        id?: string;
        name: string;
        config: ProfileConfig;
    }): Promise<ProfileRecord>;
    listProfiles(): Promise<ProfileRecord[]>;
    getProfileByName(name: string): Promise<ProfileRecord | undefined>;
    setDefaultProfileName(name: string): Promise<void>;
    getDefaultProfileName(): Promise<string | undefined>;

    createConversation(input: {
        id?: string;
        profileName?: string;
        config: ProfileConfig;
        title?: string;
    }): Promise<ConversationRecord>;
    getConversation(id: string): Promise<ConversationRecord | undefined>;
    listConversations(): Promise<ConversationRecord[]>;
    updateConversation(input: {
        id: string;
        status?: ConversationRecord["status"];
        title?: string;
    }): Promise<ConversationRecord>;

    appendConversationItem(input: ConversationItemInput): Promise<ConversationItem>;
    listConversationItems(
        conversationId: string,
        input?: { after?: number; limit?: number },
    ): Promise<ConversationItem[]>;
    getLatestItemSequence(conversationId: string): Promise<number>;

    createAgentRun(input: {
        id?: string;
        conversationId: string;
        startedThroughItemSequence: number;
        modelConfig: ModelConfig;
    }): Promise<AgentRunRecord>;
    getAgentRun(id: string): Promise<AgentRunRecord | undefined>;
    getActiveAgentRun(
        conversationId: string,
    ): Promise<AgentRunRecord | undefined>;
    listAgentRuns(conversationId: string): Promise<AgentRunRecord[]>;
    updateAgentRun(input: {
        id: string;
        status?: AgentRunStatus;
        completedThroughItemSequence?: number;
        outputItemId?: string;
        providerResponse?: ProviderResponse;
        accounting?: ModelAccounting;
        error?: JSONType;
    }): Promise<AgentRunRecord>;
    commitAssistantResponse(input: {
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        content: ContentBlock[];
        providerResponse?: ProviderResponse;
        accounting?: ModelAccounting;
        providerPayload?: ProviderPayloadDraft;
    }): Promise<{
        assistantItem: ConversationItem;
        providerPayload?: ProviderPayload;
        run: AgentRunRecord;
    }>;

    createContextBuild(input: {
        id?: string;
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        compactionItemId?: string;
        selectedItemIds: string[];
        selectedItemSequences: number[];
        diagnostics?: Record<string, JSONType>;
    }): Promise<ContextBuild>;
    listContextBuilds(conversationId: string): Promise<ContextBuild[]>;

    createProviderPayload(input: {
        id?: string;
        conversationId: string;
        itemId: string;
        itemSequence: number;
        provider: string;
        modelId: string;
        type: string;
        version: number;
        payload: JSONType;
    }): Promise<ProviderPayload>;
    listProviderPayloadsForItems(input: {
        conversationId: string;
        itemIds: string[];
        provider: string;
        modelId: string;
    }): Promise<ProviderPayload[]>;
}
