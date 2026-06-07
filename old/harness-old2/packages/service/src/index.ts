import type { HarnessKernel } from "@harness/core";
import type {
    AgentRunRecord,
    ConversationInputDelivery,
    ConversationItem,
    ConversationRecord,
    ContentBlock,
    ContextBuild,
    CompactionItem,
    PendingConversationInput,
    ProfileConfig,
    ProfileRecord,
} from "@harness/protocol";

export class HarnessService {
    public constructor(public readonly kernel: HarnessKernel) {}

    public async createProfile(input: {
        name: string;
        config: ProfileConfig;
        select?: boolean;
    }): Promise<ProfileRecord> {
        return this.kernel.createProfile(input);
    }

    public async listProfiles(): Promise<ProfileRecord[]> {
        return this.kernel.listProfiles();
    }

    public async selectProfile(name: string): Promise<ProfileRecord> {
        return this.kernel.selectProfile(name);
    }

    public async createConversation(
        input: {
            profileName?: string;
            profileConfig?: ProfileConfig;
            title?: string;
        } = {},
    ): Promise<ConversationRecord> {
        return this.kernel.createConversation(input);
    }

    public async startConversation(input: {
        message: ContentBlock[];
        profileName?: string;
        profileConfig?: ProfileConfig;
        title?: string;
    }): Promise<ConversationRecord> {
        const conversation = await this.createConversation({
            ...(input.profileName ? { profileName: input.profileName } : {}),
            ...(input.profileConfig
                ? { profileConfig: input.profileConfig }
                : {}),
            ...(input.title ? { title: input.title } : {}),
        });
        await this.send(conversation.id, input.message);
        const latest = await this.getConversation(conversation.id);
        if (!latest) {
            throw new Error(`Conversation ${conversation.id} disappeared`);
        }
        return latest;
    }

    public async listConversations(): Promise<ConversationRecord[]> {
        return this.kernel.listConversations();
    }

    public async getConversation(
        id: string,
    ): Promise<ConversationRecord | undefined> {
        return this.kernel.getConversation(id);
    }

    public async send(
        conversationId: string,
        content: ContentBlock[],
        delivery: ConversationInputDelivery = "send",
    ): Promise<ConversationItem | PendingConversationInput> {
        return this.kernel.sendConversationInput({
            conversationId,
            content,
            delivery,
        });
    }

    public async queue(
        conversationId: string,
        content: ContentBlock[],
    ): Promise<ConversationItem | PendingConversationInput> {
        return this.send(conversationId, content, "queue");
    }

    public async interrupt(
        conversationId: string,
        content: ContentBlock[],
    ): Promise<ConversationItem | PendingConversationInput> {
        return this.send(conversationId, content, "interrupt");
    }

    public async listItems(
        conversationId: string,
        input?: { after?: number; limit?: number },
    ): Promise<ConversationItem[]> {
        return this.kernel.listItems(conversationId, input);
    }

    public async listAgentRuns(
        conversationId: string,
    ): Promise<AgentRunRecord[]> {
        return this.kernel.listAgentRuns(conversationId);
    }

    public async runCompaction(
        conversationId: string,
    ): Promise<ConversationItem> {
        return this.kernel.runCompaction(conversationId);
    }

    public async listContextBuilds(
        conversationId: string,
    ): Promise<ContextBuild[]> {
        return this.kernel.listContextBuilds(conversationId);
    }

    public async listCompactions(
        conversationId: string,
    ): Promise<CompactionItem[]> {
        return this.kernel.listCompactions(conversationId);
    }
}
