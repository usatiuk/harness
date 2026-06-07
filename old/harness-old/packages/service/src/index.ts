import type { HarnessKernel, OutputPeekOptions, OutputPreview, PageRequest } from "@harness/core";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ActivityRecord,
  ArtifactRecord,
  AssetOrigin,
  AssetRecord,
  ContentBlock,
  ContextBlock,
  ContextBuild,
  EffectiveProfile,
  ExecutionContextRecord,
  HarnessEvent,
  InteractionRequest,
  JsonValue,
  MessageRecord,
  MessageRole,
  ProfileConfig,
  ProfileRecord,
  ConversationRecord,
  ConversationInputSource,
  SourceRef,
  StateNamespaceRecord,
  ConversationInputRecord,
  ConversationInputTarget,
  TurnState,
  TurnRecord,
  WorkspaceRecord
} from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "service:src";

export interface TaskOperations {
  addTask(conversationId: string, title: string): Promise<JsonValue>;
}

export interface SubagentOperations {
  delegate(input: { parentConversationId: string; prompt: string; title?: string }): Promise<{ childConversation: ConversationRecord; activity: ActivityRecord }>;
  send(input: { activityId: string; message: ContentBlock[] }): Promise<{ activity: ActivityRecord; queuedInputId: string }>;
  peek(activityId: string): Promise<{ activity: ActivityRecord; childConversation: ConversationRecord; messages: MessageRecord[] }>;
  wait(activityId: string): Promise<{ activity: ActivityRecord; childConversation: ConversationRecord; messages: MessageRecord[] }>;
  cancel(activityId: string): Promise<ActivityRecord>;
}

export interface InProcessHarnessServiceOptions {
  kernel: HarnessKernel;
  tasks?: TaskOperations;
  subagents?: SubagentOperations;
}

export class InProcessHarnessService {
  public constructor(private readonly options: InProcessHarnessServiceOptions) {}

  public get kernel(): HarnessKernel {
    return this.options.kernel;
  }

  public async createProfile(input: { name: string; config: ProfileConfig }): Promise<ProfileRecord> {
    return this.kernel.createProfile(input);
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    return this.kernel.listProfiles();
  }

  public async selectProfile(idOrName: string): Promise<ProfileRecord> {
    return this.kernel.selectProfile(idOrName);
  }

  public async startConversation(input: {
    message: ContentBlock[];
    profile?: string;
    profileOverrides?: Partial<ProfileConfig>;
    projectPath?: string;
    title?: string;
    attachments?: Array<{
      uri: string;
      mimeType: string;
      byteSize: number;
      sha256?: string;
      origin: AssetOrigin;
      metadata?: Record<string, JsonValue>;
      contentBlock: ContentBlock;
    }>;
  }): Promise<ConversationRecord> {
    const conversation = await this.kernel.createConversation({
      ...(input.profile ? { profileName: input.profile } : {}),
      ...(input.profileOverrides ? { profileOverrides: input.profileOverrides } : {}),
      ...(input.title ? { title: input.title } : {})
    });
    if (input.projectPath) {
      const execution = await this.createHostProjectContext(input.projectPath, conversation.id);
      await this.kernel.attachExecutionContext(conversation.id, execution.context.id);
    }
    const attachmentBlocks: ContentBlock[] = [];
    for (const attachment of input.attachments ?? []) {
      const asset = await this.kernel.createAsset({
        conversationId: conversation.id,
        uri: attachment.uri,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        origin: attachment.origin,
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        ...(attachment.metadata ? { metadata: attachment.metadata } : {})
      });
      attachmentBlocks.push(rewriteAttachmentBlock(attachment.contentBlock, asset.id));
    }
    await this.kernel.sendConversationInput({
      conversationId: conversation.id,
      content: [...input.message, ...attachmentBlocks],
      delivery: "asap"
    });
    const completed = await this.kernel.getConversation(conversation.id);
    if (!completed) {
      throw new Error(`Conversation ${conversation.id} disappeared after model step`);
    }
    return completed;
  }

  public async createProjectlessConversation(input: {
    profile?: string;
    profileOverrides?: Partial<ProfileConfig>;
    title?: string;
  }): Promise<ConversationRecord> {
    return this.kernel.createConversation({
      ...(input.profile ? { profileName: input.profile } : {}),
      ...(input.profileOverrides ? { profileOverrides: input.profileOverrides } : {}),
      ...(input.title ? { title: input.title } : {})
    });
  }

  public async bindHostProject(conversationId: string, projectPath: string): Promise<ConversationRecord> {
    const execution = await this.createHostProjectContext(projectPath, conversationId);
    return this.kernel.attachExecutionContext(conversationId, execution.context.id);
  }

  public async createHostProjectContext(projectPath: string, conversationId?: string): Promise<{ workspace: WorkspaceRecord; context: ExecutionContextRecord }> {
    const rootPath = await canonicalProjectRoot(projectPath);
    const workspace = await this.kernel.createWorkspace({
      kind: "host",
      rootPath,
      metadata: {}
    });
    const context = await this.kernel.createExecutionContext({
      ...(conversationId ? { conversationId } : {}),
      workspaceId: workspace.id,
      providerKind: "host",
      cwd: rootPath,
      env: {},
      providerConfig: {}
    });
    return { workspace, context };
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return this.kernel.listConversations();
  }

  public async getConversation(id: string): Promise<ConversationRecord | undefined> {
    return this.kernel.getConversation(id);
  }

  public async getEffectiveConfig(conversationId: string): Promise<EffectiveProfile> {
    const conversation = await this.kernel.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return conversation.effectiveProfile;
  }

  public async continueConversation(conversationId: string, message: ContentBlock[]): Promise<ConversationInputRecord> {
    return this.kernel.sendConversationInput({
      conversationId,
      content: message,
      delivery: "asap"
    });
  }

  public async steerConversation(conversationId: string, message: ContentBlock[]): Promise<ConversationInputRecord> {
    return this.kernel.sendConversationInput({
      conversationId,
      content: message,
      delivery: "asap"
    });
  }

  public async sendConversationInput(input: {
    conversationId: string;
    message: ContentBlock[];
    delivery?: "asap" | "after_active" | "manual";
    role?: MessageRole;
    target?: ConversationInputTarget;
    source?: ConversationInputSource;
    sourceRef?: SourceRef;
  }): Promise<ConversationInputRecord> {
    return this.kernel.sendConversationInput({
      conversationId: input.conversationId,
      content: input.message,
      delivery: input.delivery ?? "asap",
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {})
    });
  }

  public async listTurns(conversationId: string): Promise<TurnRecord[]> {
    return this.kernel.listTurns(conversationId);
  }

  public async resumeTurn(turnId: string): Promise<TurnRecord> {
    return this.kernel.resumeTurn(turnId);
  }

  public async interruptTurn(turnId: string, reason?: string): Promise<TurnRecord> {
    return this.kernel.interruptTurn(turnId, reason);
  }

  public async listEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]> {
    return this.kernel.listEvents(conversationId, page);
  }

  public async listProviderEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]> {
    return (await this.kernel.listEvents(conversationId, page)).filter((event) => event.type === "provider.event");
  }

  public async listActivities(conversationId: string): Promise<ActivityRecord[]> {
    return this.kernel.listActivities(conversationId);
  }

  public async peekActivityOutput(activityId: string, input?: OutputPeekOptions): Promise<OutputPreview | undefined> {
    return this.kernel.peekActivityOutput(activityId, input);
  }

  public async peekToolOutput(toolExecutionId: string, input?: OutputPeekOptions): Promise<OutputPreview | undefined> {
    return this.kernel.peekToolOutput(toolExecutionId, input);
  }

  public async listAssets(conversationId?: string): Promise<AssetRecord[]> {
    return this.kernel.listAssets(conversationId);
  }

  public async listArtifacts(conversationId: string): Promise<ArtifactRecord[]> {
    return this.kernel.listArtifacts(conversationId);
  }

  public async listState(conversationId: string): Promise<StateNamespaceRecord[]> {
    return this.kernel.store.listStateNamespaces(conversationId);
  }

  public async listExecutionContexts(conversationId?: string): Promise<ExecutionContextRecord[]> {
    return this.kernel.listExecutionContexts(conversationId);
  }

  public async listPendingInteractions(conversationId?: string): Promise<InteractionRequest[]> {
    return this.kernel.listPendingInteractions(conversationId);
  }

  public async getInteraction(id: string): Promise<InteractionRequest | undefined> {
    return this.kernel.getInteraction(id);
  }

  public async answerInteraction(id: string, response: JsonValue): Promise<InteractionRequest> {
    return this.kernel.answerInteraction(id, response);
  }

  public async cancelInteraction(id: string): Promise<InteractionRequest> {
    return this.kernel.cancelInteraction(id);
  }

  public async getTurnState(turnId: string): Promise<TurnState | undefined> {
    return this.kernel.getTurnState(turnId);
  }

  public async listContextBlocks(conversationId: string): Promise<ContextBlock[]> {
    return this.kernel.listContextBlocks(conversationId);
  }

  public async listContextBuilds(conversationId: string): Promise<ContextBuild[]> {
    return this.kernel.listContextBuilds(conversationId);
  }

  public async runCompaction(conversationId: string): Promise<ContextBlock> {
    return this.kernel.runCompaction(conversationId);
  }

  public async addTask(conversationId: string, title: string): Promise<JsonValue> {
    if (!this.options.tasks) {
      throw new Error("Task operations are not wired");
    }
    return this.options.tasks.addTask(conversationId, title);
  }

  public async delegateSubagent(input: { parentConversationId: string; prompt: string; title?: string }): Promise<{ childConversation: ConversationRecord; activity: ActivityRecord }> {
    if (!this.options.subagents) {
      throw new Error("Subagent operations are not wired");
    }
    return this.options.subagents.delegate(input);
  }

  public async sendSubagent(input: { activityId: string; message: ContentBlock[] }): Promise<{ activity: ActivityRecord; queuedInputId: string }> {
    if (!this.options.subagents) {
      throw new Error("Subagent operations are not wired");
    }
    return this.options.subagents.send(input);
  }

  public async peekSubagent(activityId: string): Promise<{ activity: ActivityRecord; childConversation: ConversationRecord; messages: MessageRecord[] }> {
    if (!this.options.subagents) {
      throw new Error("Subagent operations are not wired");
    }
    return this.options.subagents.peek(activityId);
  }

  public async waitSubagent(activityId: string): Promise<{ activity: ActivityRecord; childConversation: ConversationRecord; messages: MessageRecord[] }> {
    if (!this.options.subagents) {
      throw new Error("Subagent operations are not wired");
    }
    return this.options.subagents.wait(activityId);
  }

  public async cancelSubagent(activityId: string): Promise<ActivityRecord> {
    if (!this.options.subagents) {
      throw new Error("Subagent operations are not wired");
    }
    return this.options.subagents.cancel(activityId);
  }
}

async function canonicalProjectRoot(projectPath: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(projectPath));
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
  }
  return resolved;
}

function rewriteAttachmentBlock(block: ContentBlock, assetId: string): ContentBlock {
  switch (block.type) {
    case "image_ref":
      return { ...block, assetId };
    case "file_ref":
      return { ...block, assetId };
    case "audio_ref":
      return { ...block, assetId };
    case "pdf_ref":
      return { ...block, assetId };
    default:
      return block;
  }
}
