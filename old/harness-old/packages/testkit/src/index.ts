import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProfileResolver,
  createId,
  HarnessKernel,
  nowIso,
  type HarnessPlugin,
  type HarnessStore,
  type HarnessTool,
  type ModelAdapter,
  type PageRequest,
  type ActiveProcess,
  type ExecutionCommandInput,
  type ExecutionCommandOutput,
  type ExecutionOutputSinks,
  type ExecutionProvider,
  type ExecutionRuntime,
  type LiveOutputSink,
  type ToolOutputPresenterFactory
} from "@harness/core";
import { createControlPlugin } from "@harness/plugin-control";
import { createMcpPlugin } from "@harness/plugin-mcp";
import { createSubagentsPlugin, SubagentDelegator } from "@harness/plugin-subagents";
import { createTasksPlugin, TaskManager } from "@harness/plugin-tasks";
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
  ModelCapabilities,
  ModelConfig,
  ModelStepInput,
  ModelStepResult,
  ProfileConfig,
  ProfileRecord,
  ProviderEventPayload,
  ProviderResumeState,
  ConversationRecord,
  ConversationStatus,
  StateNamespaceRecord,
  ToolCall,
  TurnState,
  TurnStatePhase,
  ConversationInputRecord,
  ConversationInputSource,
  ConversationInputStatus,
  ConversationInputTarget,
  TurnRecord,
  TurnStatus,
  WorkspaceRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
  SourceRef,
  ToolResult
} from "@harness/protocol";
import { InProcessHarnessService } from "@harness/service";
import { createHostExecutionProvider } from "@harness/sandbox-host";
import { openSqliteHarnessStore, type SqliteHarnessStore } from "@harness/store-sqlite";
import { createBasicTools, createBasicToolsPlugin } from "@harness/tools-basic";

export const SOURCE_FIRST_MARKER = "testkit:src";

export class RecordingFakeModelAdapter implements ModelAdapter {
  public readonly id = "fake";
  public readonly provider = "fake";
  public readonly inputs: ModelStepInput[] = [];

  public constructor(
    private readonly options: {
      text?: string;
      toolCall?: ToolCall;
      capabilities?: Partial<ModelCapabilities>;
      providerEvents?: ProviderEventPayload[];
      supportedNativeToolKinds?: string[];
    } = {}
  ) {}

  public capabilities(): ModelCapabilities {
    return {
      textInput: true,
      textOutput: true,
      imageInput: false,
      fileInput: false,
      pdfInput: false,
      audioInput: false,
      audioOutput: false,
      toolCalling: true,
      hostedTools: false,
      reasoningMetadata: false,
      ...this.options.capabilities
    };
  }

  public supportedNativeToolKinds(): string[] {
    return this.options.supportedNativeToolKinds ?? ["web_search", "reasoning", "code_interpreter"];
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.adapter !== this.id) {
      throw new Error(`Fake adapter cannot run adapter ${config.adapter}`);
    }
    if (config.provider !== this.provider) {
      throw new Error(`Fake adapter cannot run provider ${config.provider}`);
    }
  }

  public async step(input: ModelStepInput): Promise<ModelStepResult> {
    this.inputs.push(input);
    const lastText = input.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const completedToolCallIds = new Set(input.messages.flatMap((message) =>
      message.content.flatMap((block) => block.type === "tool_result_ref" ? [block.toolCallId] : [])
    ));
    const hasToolResult = completedToolCallIds.size > 0;
    const toolCall = this.options.toolCall ?? (hasToolResult ? undefined : parseInlineToolCall(lastText));
    const pendingToolCall = toolCall && !completedToolCallIds.has(toolCall.id) ? toolCall : undefined;
    return {
      content: [{ type: "text", text: this.options.text ?? "fake model response" }],
      toolCalls: pendingToolCall ? [pendingToolCall] : [],
      providerEvents: this.options.providerEvents ?? input.modelConfig.nativeTools.filter((tool) => tool.enabled).map((tool, sequence) => ({
        provider: input.modelConfig.provider,
        modelId: input.modelConfig.modelId,
        sequence,
        kind: `native_tool.${tool.kind}`,
        normalized: { kind: tool.kind, name: tool.name ?? null }
      })),
      metadata: { fake: "true" }
    };
  }
}

export function createFakeMultimodalModel(): RecordingFakeModelAdapter {
  return new RecordingFakeModelAdapter({
    capabilities: {
      imageInput: true,
      fileInput: true,
      pdfInput: true,
      audioInput: true
    }
  });
}

export class FakeExecutionProvider implements ExecutionProvider {
  public readonly kind = "fake";

  public constructor(private readonly runtime = new FakeExecutionRuntime()) {}

  public async resolve(context: ExecutionContextRecord): Promise<ExecutionRuntime> {
    this.runtime.context = context;
    return this.runtime;
  }
}

export class FakeExecutionRuntime implements ExecutionRuntime {
  public context: ExecutionContextRecord = {
    id: "ctx_fake",
    providerKind: "fake",
    env: {},
    providerConfig: {},
    status: "ready",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  private readonly files = new Map<string, string | Buffer>([
    ["README.md", "hello from fake sandbox\n"],
    ["image.fake", Buffer.from([0, 1, 2, 3])]
  ]);

  public async readFile(filePath: string): Promise<{
    kind: "text" | "binary";
    text?: string;
    uri?: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
  }> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw new Error(`Fake file ${filePath} not found`);
    }
    if (typeof value === "string") {
      return { kind: "text", text: value, mimeType: "text/plain", byteSize: Buffer.byteLength(value) };
    }
    return { kind: "binary", uri: `fake://${filePath}`, mimeType: "image/png", byteSize: value.byteLength };
  }

  public async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  public async listFiles(_filePath: string): Promise<Array<{ path: string; kind: "file" | "directory"; byteSize?: number }>> {
    return [...this.files.entries()].map(([filePath, value]) => ({
      path: filePath,
      kind: "file",
      byteSize: typeof value === "string" ? Buffer.byteLength(value) : value.byteLength
    }));
  }

  public async grep(input: { pattern: string; path?: string; limit?: number }): Promise<Array<{ path: string; line: number; text: string }>> {
    const rows: Array<{ path: string; line: number; text: string }> = [];
    for (const [filePath, value] of this.files) {
      if (typeof value !== "string") {
        continue;
      }
      const lines = value.split(/\r?\n/u);
      for (const [index, line] of lines.entries()) {
        if (line.includes(input.pattern)) {
          rows.push({ path: filePath, line: index + 1, text: line });
          if (rows.length >= (input.limit ?? 50)) {
            return rows;
          }
        }
      }
    }
    return rows;
  }

  public async runCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ExecutionCommandOutput> {
    await sinks.stdout(`fake stdout: ${input.command}\n`);
    await sinks.stderr(`fake stderr: ${input.command}\n`);
    return { exitCode: 0 };
  }

  public async startCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess> {
    await sinks.stdout(`fake stdout: ${input.command}\n`);
    await sinks.stderr(`fake stderr: ${input.command}\n`);
    return {
      pid: 99999,
      wait: async () => ({ exitCode: 0 }),
      cancel: async () => {}
    };
  }
}

export class MemoryHarnessStore implements HarnessStore {
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly messageSequences = new Map<string, number>();
  private readonly activities = new Map<string, ActivityRecord>();
  private readonly events: HarnessEvent[] = [];
  private readonly assets = new Map<string, AssetRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly states = new Map<string, StateNamespaceRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly contexts = new Map<string, ExecutionContextRecord>();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly conversationInputs = new Map<string, ConversationInputRecord>();
  private readonly interactions = new Map<string, InteractionRequest>();
  private readonly contextBlocks = new Map<string, ContextBlock>();
  private readonly contextSources = new Map<string, ContextBlockSource[]>();
  private readonly contextModelMetadata = new Map<string, ContextModelMetadata>();
  private readonly contextBuilds = new Map<string, ContextBuild>();
  private readonly contextBuildItems = new Map<string, ContextBuildItem[]>();
  private readonly toolExecutions = new Map<string, ToolExecutionRecord>();
  private readonly kv = new Map<string, JsonValue>();
  private eventSequence = 0;

  public async createProfile(input: { id?: string; name: string; config: ProfileConfig }): Promise<ProfileRecord> {
    const timestamp = nowIso();
    const profile: ProfileRecord = {
      id: input.id ?? createId("profile"),
      name: input.name,
      config: input.config,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.profiles.set(profile.id, profile);
    return profile;
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    return [...this.profiles.values()];
  }

  public async getProfile(id: string): Promise<ProfileRecord | undefined> {
    return this.profiles.get(id);
  }

  public async getProfileByName(name: string): Promise<ProfileRecord | undefined> {
    return [...this.profiles.values()].find((profile) => profile.name === name);
  }

  public async updateProfile(id: string, config: ProfileConfig): Promise<ProfileRecord> {
    const current = required(this.profiles.get(id), `Profile ${id} not found`);
    const next: ProfileRecord = { ...current, config, updatedAt: nowIso() };
    this.profiles.set(id, next);
    return next;
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
    const conversation = compactRecord({
      id: input.id ?? createId("conv"),
      parentConversationId: input.parentConversationId,
      profileId: input.profileId,
      effectiveProfile: input.effectiveProfile,
      executionContextId: input.executionContextId,
      providerResumeState: undefined,
      title: input.title,
      status: "created" as ConversationStatus,
      createdAt: timestamp,
      updatedAt: timestamp
    }) as ConversationRecord;
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  public async getConversation(id: string): Promise<ConversationRecord | undefined> {
    return this.conversations.get(id);
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return [...this.conversations.values()];
  }

  public async updateConversation(input: {
    id: string;
    status?: ConversationStatus;
    executionContextId?: string;
    effectiveProfile?: EffectiveProfile;
    providerResumeState?: ProviderResumeState;
  }): Promise<ConversationRecord> {
    const current = required(this.conversations.get(input.id), `Conversation ${input.id} not found`);
    const next = compactRecord({
      ...current,
      status: input.status ?? current.status,
      executionContextId: input.executionContextId ?? current.executionContextId,
      effectiveProfile: input.effectiveProfile ?? current.effectiveProfile,
      providerResumeState: input.providerResumeState === undefined ? current.providerResumeState : input.providerResumeState,
      updatedAt: nowIso()
    }) as ConversationRecord;
    this.conversations.set(next.id, next);
    return next;
  }

  public async createTurn(input: {
    id?: string;
    conversationId: string;
    parentTurnId?: string;
    status?: TurnStatus;
    inputMessageIds?: string[];
  }): Promise<TurnRecord> {
    const status = input.status ?? "running";
    if (status === "running" || status === "waiting") {
      const active = await this.getActiveTurn(input.conversationId);
      if (active) {
        throw new Error(`Conversation ${input.conversationId} already has an active turn`);
      }
    }
    const timestamp = nowIso();
    const turn = compactRecord({
      id: input.id ?? createId("turn"),
      conversationId: input.conversationId,
      parentTurnId: input.parentTurnId,
      status,
      inputMessageIds: input.inputMessageIds ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    }) as TurnRecord;
    this.turns.set(turn.id, turn);
    return turn;
  }

  public async getTurn(id: string): Promise<TurnRecord | undefined> {
    return this.turns.get(id);
  }

  public async getActiveTurn(conversationId: string): Promise<TurnRecord | undefined> {
    return [...this.turns.values()].reverse().find((turn) => turn.conversationId === conversationId && (turn.status === "running" || turn.status === "waiting"));
  }

  public async listTurns(conversationId: string): Promise<TurnRecord[]> {
    return [...this.turns.values()].filter((turn) => turn.conversationId === conversationId);
  }

  public async updateTurn(input: { id: string; status?: TurnStatus; inputMessageIds?: string[] }): Promise<TurnRecord> {
    const current = required(this.turns.get(input.id), `Turn ${input.id} not found`);
    const nextStatus = input.status ?? current.status;
    if (nextStatus === "running" || nextStatus === "waiting") {
      const active = await this.getActiveTurn(current.conversationId);
      if (active && active.id !== current.id) {
        throw new Error(`Conversation ${current.conversationId} already has an active turn`);
      }
    }
    const next = compactRecord({
      ...current,
      status: nextStatus,
      inputMessageIds: input.inputMessageIds ?? current.inputMessageIds,
      updatedAt: nowIso()
    }) as TurnRecord;
    this.turns.set(next.id, next);
    return next;
  }

  public async createMessage(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    role: MessageRole;
    content: ContentBlock[];
    source?: SourceRef;
  }): Promise<MessageRecord> {
    const sequence = this.messageSequences.get(input.conversationId) ?? 0;
    this.messageSequences.set(input.conversationId, sequence + 1);
    const message = compactRecord({
      id: input.id ?? createId("msg"),
      conversationId: input.conversationId,
      sequence,
      turnId: input.turnId,
      role: input.role,
      content: input.content,
      source: input.source,
      createdAt: nowIso()
    }) as MessageRecord;
    this.messages.set(message.id, message);
    return message;
  }

  public async listMessages(conversationId: string, input?: { limit?: number }): Promise<MessageRecord[]> {
    const rows = [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((left, right) => left.sequence - right.sequence);
    return rows.slice(Math.max(0, rows.length - (input?.limit ?? 50)));
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
    const activity = compactRecord({
      id: input.id ?? createId("act"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      parentActivityId: input.parentActivityId,
      ownerPluginId: input.ownerPluginId,
      kind: input.kind,
      label: input.label,
      status: input.status ?? "queued",
      cancellable: input.cancellable ?? true,
      activityState: input.activityState,
      onCompletion: input.onCompletion,
      createdAt: timestamp,
      updatedAt: timestamp
    }) as ActivityRecord;
    this.activities.set(activity.id, activity);
    return activity;
  }

  public async updateActivity(input: { id: string; status?: ActivityStatus; activityState?: JsonValue; result?: JsonValue }): Promise<ActivityRecord> {
    const current = required(this.activities.get(input.id), `Activity ${input.id} not found`);
    const next = compactRecord({
      ...current,
      status: input.status ?? current.status,
      activityState: input.activityState === undefined ? current.activityState : input.activityState,
      result: input.result === undefined ? current.result : input.result,
      updatedAt: nowIso()
    }) as ActivityRecord;
    this.activities.set(next.id, next);
    return next;
  }

  public async getActivity(id: string): Promise<ActivityRecord | undefined> {
    return this.activities.get(id);
  }

  public async listActivities(conversationId: string): Promise<ActivityRecord[]> {
    return [...this.activities.values()].filter((activity) => activity.conversationId === conversationId);
  }

  public async appendEvent(input: { id?: string; conversationId: string; turnId?: string; source?: SourceRef; type: string; payload: JsonValue }): Promise<HarnessEvent> {
    const event = compactRecord({
      sequence: ++this.eventSequence,
      id: input.id ?? createId("evt"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      source: input.source,
      type: input.type,
      payload: input.payload,
      createdAt: nowIso()
    }) as HarnessEvent;
    this.events.push(event);
    return event;
  }

  public async listEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]> {
    return this.events.filter((event) => event.conversationId === conversationId && event.sequence > (page?.after ?? 0)).slice(0, page?.limit ?? 50);
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
    const asset = compactRecord({
      id: input.id ?? createId("asset"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      source: input.source,
      messageId: input.messageId,
      uri: input.uri,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      origin: input.origin,
      metadata: input.metadata ?? {},
      derivedFromAssetId: input.derivedFromAssetId,
      createdAt: nowIso()
    }) as AssetRecord;
    this.assets.set(asset.id, asset);
    return asset;
  }

  public async getAsset(id: string): Promise<AssetRecord | undefined> {
    return this.assets.get(id);
  }

  public async listAssets(conversationId?: string): Promise<AssetRecord[]> {
    return [...this.assets.values()].filter((asset) => conversationId === undefined || asset.conversationId === conversationId);
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
    const artifact = compactRecord({
      id: input.id ?? createId("artifact"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      source: input.source,
      kind: input.kind,
      uri: input.uri,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    }) as ArtifactRecord;
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  public async listArtifacts(conversationId: string): Promise<ArtifactRecord[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.conversationId === conversationId);
  }

  public async getStateNamespace(conversationId: string, namespace: string): Promise<StateNamespaceRecord | undefined> {
    return this.states.get(stateKey(conversationId, namespace));
  }

  public async upsertStateNamespace(input: { conversationId: string; namespace: string; value: JsonValue }): Promise<StateNamespaceRecord> {
    const current = await this.getStateNamespace(input.conversationId, input.namespace);
    const state: StateNamespaceRecord = {
      conversationId: input.conversationId,
      namespace: input.namespace,
      value: input.value,
      version: (current?.version ?? 0) + 1,
      updatedAt: nowIso()
    };
    this.states.set(stateKey(input.conversationId, input.namespace), state);
    return state;
  }

  public async listStateNamespaces(conversationId: string): Promise<StateNamespaceRecord[]> {
    return [...this.states.values()].filter((state) => state.conversationId === conversationId);
  }

  public async createWorkspace(input: { id?: string; kind: string; rootPath?: string; metadata?: Record<string, JsonValue> }): Promise<WorkspaceRecord> {
    const workspace = compactRecord({
      id: input.id ?? createId("workspace"),
      kind: input.kind,
      rootPath: input.rootPath,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    }) as WorkspaceRecord;
    this.workspaces.set(workspace.id, workspace);
    return workspace;
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
    const context = compactRecord({
      id: input.id ?? createId("ctx"),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      providerKind: input.providerKind,
      cwd: input.cwd,
      env: input.env ?? {},
      providerConfig: input.providerConfig ?? {},
      status: input.status ?? "ready",
      createdAt: timestamp,
      updatedAt: timestamp
    }) as ExecutionContextRecord;
    this.contexts.set(context.id, context);
    return context;
  }

  public async getExecutionContext(id: string): Promise<ExecutionContextRecord | undefined> {
    return this.contexts.get(id);
  }

  public async listExecutionContexts(conversationId?: string): Promise<ExecutionContextRecord[]> {
    return [...this.contexts.values()].filter((context) => conversationId === undefined || context.conversationId === conversationId);
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
    const previous = this.turnStates.get(input.turnId);
    const state = compactRecord({
      id: previous?.id ?? input.id ?? createId("state"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      phase: input.phase,
      activeToolExecutionId: input.activeToolExecutionId,
      activeActivityId: input.activeActivityId,
      contextBuildId: input.contextBuildId,
      pendingToolCalls: input.pendingToolCalls ?? [],
      completedToolCallIds: input.completedToolCallIds ?? previous?.completedToolCallIds ?? [],
      pendingInteractionIds: input.pendingInteractionIds ?? [],
      pendingSteeringMessageIds: input.pendingSteeringMessageIds ?? [],
      providerResumeState: input.providerResumeState === undefined ? previous?.providerResumeState : input.providerResumeState,
      loopState: input.loopState ?? {},
      createdAt: previous?.createdAt ?? nowIso()
    }) as TurnState;
    this.turnStates.set(input.turnId, state);
    if (input.providerResumeState !== undefined) {
      await this.updateConversation({ id: input.conversationId, providerResumeState: input.providerResumeState });
    }
    return state;
  }

  public async getTurnState(turnId: string): Promise<TurnState | undefined> {
    return this.turnStates.get(turnId);
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
    const record = compactRecord({
      id: input.id ?? createId("input"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      source: input.source,
      sourceRef: input.sourceRef,
      delivery: input.delivery,
      target: input.target,
      role: input.role,
      content: input.content,
      status: "pending" as ConversationInputStatus,
      createdAt: nowIso()
    }) as ConversationInputRecord;
    this.conversationInputs.set(record.id, record);
    return record;
  }

  public async listConversationInputs(input: {
    conversationId: string;
    turnId?: string;
    delivery?: "asap" | "after_active" | "manual";
    status?: ConversationInputStatus;
  }): Promise<ConversationInputRecord[]> {
    return [...this.conversationInputs.values()].filter((record) =>
      record.conversationId === input.conversationId &&
      (input.turnId === undefined || record.turnId === input.turnId) &&
      (input.delivery === undefined || record.delivery === input.delivery) &&
      (input.status === undefined || record.status === input.status)
    );
  }

  public async consumeConversationInput(input: { id: string; turnId: string; consumedMessageId: string }): Promise<ConversationInputRecord> {
    const current = required(this.conversationInputs.get(input.id), `Conversation input ${input.id} not found`);
    const next = compactRecord({
      ...current,
      turnId: input.turnId,
      status: "consumed" as ConversationInputStatus,
      consumedMessageId: input.consumedMessageId,
      consumedAt: nowIso()
    }) as ConversationInputRecord;
    this.conversationInputs.set(next.id, next);
    return next;
  }

  public async cancelConversationInput(id: string): Promise<ConversationInputRecord> {
    const current = required(this.conversationInputs.get(id), `Conversation input ${id} not found`);
    const next = compactRecord({
      ...current,
      status: "cancelled" as ConversationInputStatus
    }) as ConversationInputRecord;
    this.conversationInputs.set(next.id, next);
    return next;
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
    const interaction = compactRecord({
      id: input.id ?? createId("intr"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      toolExecutionId: input.toolExecutionId,
      activityId: input.activityId,
      origin: input.origin,
      kind: input.kind,
      status: "pending" as InteractionStatus,
      prompt: input.prompt,
      requestedSchema: input.requestedSchema,
      render: input.render,
      createdAt: timestamp,
      updatedAt: timestamp
    }) as InteractionRequest;
    this.interactions.set(interaction.id, interaction);
    return interaction;
  }

  public async getInteractionRequest(id: string): Promise<InteractionRequest | undefined> {
    return this.interactions.get(id);
  }

  public async listInteractionRequests(conversationId?: string): Promise<InteractionRequest[]> {
    return [...this.interactions.values()].filter((interaction) => conversationId === undefined || interaction.conversationId === conversationId);
  }

  public async listPendingInteractions(conversationId?: string): Promise<InteractionRequest[]> {
    return (await this.listInteractionRequests(conversationId)).filter((interaction) => interaction.status === "pending");
  }

  public async updateInteractionRequest(input: { id: string; expectedStatus?: InteractionStatus; status?: InteractionStatus; response?: JsonValue }): Promise<InteractionRequest> {
    const current = required(this.interactions.get(input.id), `Interaction ${input.id} not found`);
    if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
      throw new Error(`Interaction ${input.id} expected status ${input.expectedStatus} but was ${current.status}`);
    }
    const next = compactRecord({
      ...current,
      status: input.status ?? current.status,
      response: input.response === undefined ? current.response : input.response,
      updatedAt: nowIso()
    }) as InteractionRequest;
    this.interactions.set(next.id, next);
    return next;
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
    const block = compactRecord({
      id: input.id ?? createId("ctxb"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      source: input.source,
      kind: input.kind,
      content: input.content ?? [],
      data: input.data,
      metadata: input.metadata ?? {},
      coverageCursor: input.coverageCursor,
      policyId: input.policyId,
      sourceContextBuildId: input.sourceContextBuildId,
      createdAt: nowIso()
    }) as ContextBlock;
    this.contextBlocks.set(block.id, block);
    return block;
  }

  public async getContextBlock(id: string): Promise<ContextBlock | undefined> {
    return this.contextBlocks.get(id);
  }

  public async listContextBlocks(conversationId: string, input?: { turnId?: string; kind?: ContextBlockKind }): Promise<ContextBlock[]> {
    return [...this.contextBlocks.values()].filter((block) =>
      block.conversationId === conversationId &&
      (input?.turnId === undefined || block.turnId === input.turnId) &&
      (input?.kind === undefined || block.kind === input.kind)
    );
  }

  public async createContextBlockSource(input: {
    blockId: string;
    sourceKind: string;
    sourceId?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBlockSource> {
    const source = compactRecord({
      blockId: input.blockId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    }) as ContextBlockSource;
    const rows = this.contextSources.get(input.blockId) ?? [];
    rows.push(source);
    this.contextSources.set(input.blockId, rows);
    return source;
  }

  public async listContextBlockSources(blockId: string): Promise<ContextBlockSource[]> {
    return this.contextSources.get(blockId) ?? [];
  }

  public async createContextModelMetadata(input: {
    id?: string;
    blockId: string;
    provider: string;
    modelId: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextModelMetadata> {
    const metadata = {
      id: input.id ?? createId("ctxm"),
      blockId: input.blockId,
      provider: input.provider,
      modelId: input.modelId,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    };
    this.contextModelMetadata.set(metadata.id, metadata);
    return metadata;
  }

  public async listContextModelMetadata(blockId?: string): Promise<ContextModelMetadata[]> {
    return [...this.contextModelMetadata.values()].filter((metadata) => blockId === undefined || metadata.blockId === blockId);
  }

  public async createContextBuild(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    modelConfig: ModelConfig;
    policyId: string;
    diagnostics?: Record<string, JsonValue>;
  }): Promise<ContextBuild> {
    const build = compactRecord({
      id: input.id ?? createId("ctxbuild"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      modelConfig: input.modelConfig,
      policyId: input.policyId,
      diagnostics: input.diagnostics ?? {},
      createdAt: nowIso()
    }) as ContextBuild;
    this.contextBuilds.set(build.id, build);
    this.contextBuildItems.set(build.id, []);
    return build;
  }

  public async getContextBuild(id: string): Promise<ContextBuild | undefined> {
    return this.contextBuilds.get(id);
  }

  public async listContextBuilds(conversationId: string): Promise<ContextBuild[]> {
    return [...this.contextBuilds.values()].filter((build) => build.conversationId === conversationId);
  }

  public async addContextBuildItem(input: {
    contextBuildId: string;
    blockId: string;
    sequence: number;
    role?: MessageRole;
    tokenEstimate?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBuildItem> {
    const item = compactRecord({
      contextBuildId: input.contextBuildId,
      blockId: input.blockId,
      sequence: input.sequence,
      role: input.role,
      tokenEstimate: input.tokenEstimate,
      metadata: input.metadata ?? {}
    }) as ContextBuildItem;
    const rows = this.contextBuildItems.get(input.contextBuildId) ?? [];
    rows.push(item);
    this.contextBuildItems.set(input.contextBuildId, rows);
    return item;
  }

  public async listContextBuildItems(contextBuildId: string): Promise<ContextBuildItem[]> {
    return this.contextBuildItems.get(contextBuildId) ?? [];
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
    const exec = compactRecord({
      id: input.id ?? createId("toolexec"),
      conversationId: input.conversationId,
      turnId: input.turnId,
      requestMessageId: input.requestMessageId,
      contextBuildId: input.contextBuildId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      status: input.status ?? "running",
      pendingInteractionIds: input.pendingInteractionIds ?? [],
      resumeState: input.resumeState,
      result: input.result,
      createdActivityIds: input.createdActivityIds ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    }) as ToolExecutionRecord;
    this.toolExecutions.set(exec.id, exec);
    return exec;
  }

  public async updateToolExecution(input: {
    id: string;
    status?: ToolExecutionStatus;
    pendingInteractionIds?: string[];
    resumeState?: JsonValue;
    result?: ToolResult;
    createdActivityIds?: string[];
  }): Promise<ToolExecutionRecord> {
    const current = required(this.toolExecutions.get(input.id), `ToolExecution ${input.id} not found`);
    const next = compactRecord({
      ...current,
      status: input.status ?? current.status,
      pendingInteractionIds: input.pendingInteractionIds !== undefined ? input.pendingInteractionIds : current.pendingInteractionIds,
      resumeState: input.resumeState !== undefined ? input.resumeState : current.resumeState,
      result: input.result !== undefined ? input.result : current.result,
      createdActivityIds: input.createdActivityIds !== undefined ? input.createdActivityIds : current.createdActivityIds,
      updatedAt: nowIso()
    }) as ToolExecutionRecord;
    this.toolExecutions.set(next.id, next);
    return next;
  }

  public async getToolExecution(id: string): Promise<ToolExecutionRecord | undefined> {
    return this.toolExecutions.get(id);
  }

  public async getToolExecutionByTurnAndToolCallId(turnId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined> {
    return [...this.toolExecutions.values()].find((exec) => exec.turnId === turnId && exec.toolCallId === toolCallId);
  }

  public async listToolExecutions(conversationId: string): Promise<ToolExecutionRecord[]> {
    return [...this.toolExecutions.values()].filter((exec) => exec.conversationId === conversationId);
  }

  public async finalizeToolExecution(input: {
    conversationId: string;
    turnId: string;
    toolExecutionId: string;
    call: ToolCall;
    status: ToolExecutionStatus;
    result: ToolResult;
  }): Promise<{ execution: ToolExecutionRecord; message: MessageRecord; resultBlock: ContextBlock; fileReadBlock?: ContextBlock; event: HarnessEvent }> {
    const current = required(this.toolExecutions.get(input.toolExecutionId), `ToolExecution ${input.toolExecutionId} not found`);
    if (current.conversationId !== input.conversationId || current.turnId !== input.turnId || current.toolCallId !== input.call.id) {
      throw new Error(`ToolExecution ${input.toolExecutionId} does not match call ${input.call.id}`);
    }
    if (input.result.toolCallId !== input.call.id) {
      throw new Error(`Tool result ${input.result.toolCallId} does not match call ${input.call.id}`);
    }

    const source = { type: "tool_execution" as const, id: input.toolExecutionId };
    const existingMessage = [...this.messages.values()].find((message) =>
      message.conversationId === input.conversationId &&
      message.turnId === input.turnId &&
      message.role === "tool" &&
      message.source?.type === source.type &&
      message.source.id === source.id
    );
    if (existingMessage) {
      if (current.status !== input.status || !jsonEqual(current.result, input.result)) {
        throw new Error(`ToolExecution ${input.toolExecutionId} was already finalized differently`);
      }
      const resultBlock = required(
        [...this.contextBlocks.values()].find((block) => block.source?.type === source.type && block.source.id === source.id && block.kind === "tool_result"),
        `ToolExecution ${input.toolExecutionId} is missing tool_result context block`
      );
      const event = required(
        this.events.find((event) => event.source?.type === source.type && event.source.id === source.id && event.type === "tool.completed"),
        `ToolExecution ${input.toolExecutionId} is missing completion event`
      );
      const fileReadBlock = [...this.contextBlocks.values()].find((block) => block.source?.type === source.type && block.source.id === source.id && block.kind === "file_read");
      return { execution: current, message: existingMessage, resultBlock, ...(fileReadBlock ? { fileReadBlock } : {}), event };
    }

    const execution = await this.updateToolExecution({ id: input.toolExecutionId, status: input.status, result: input.result });
    const message = await this.createMessage({
      conversationId: input.conversationId,
      turnId: input.turnId,
      role: "tool",
      source,
      content: [
        ...input.result.content,
        { type: "tool_result_ref", toolCallId: input.call.id, toolExecutionId: input.toolExecutionId, status: input.result.status }
      ]
    });
    const resultBlock = await this.createContextBlock({
      conversationId: input.conversationId,
      turnId: input.turnId,
      source,
      kind: "tool_result",
      content: input.result.content,
      data: {
        toolCallId: input.call.id,
        status: input.result.status,
        summary: input.result.summary,
        resultData: input.result.data ?? null
      }
    });
    const fileReadBlock = input.call.name === "read_file" && isRecord(input.result.data) && typeof input.result.data.path === "string"
      ? await this.createContextBlock({
        conversationId: input.conversationId,
        turnId: input.turnId,
        source,
        kind: "file_read",
        content: input.result.content,
        data: input.result.data,
        metadata: { path: input.result.data.path }
      })
      : undefined;
    const event = await this.appendEvent({
      conversationId: input.conversationId,
      turnId: input.turnId,
      source,
      type: "tool.completed",
      payload: { toolExecutionId: input.toolExecutionId, toolCallId: input.result.toolCallId, status: input.result.status, summary: input.result.summary }
    });
    return { execution, message, resultBlock, ...(fileReadBlock ? { fileReadBlock } : {}), event };
  }

  public async getPluginKv(namespace: string, key: string): Promise<JsonValue | undefined> {
    return this.kv.get(`${namespace}:${key}`);
  }

  public async setPluginKv(namespace: string, key: string, value: JsonValue): Promise<void> {
    this.kv.set(`${namespace}:${key}`, value);
  }
}

export interface TestHarness {
  store: MemoryHarnessStore | SqliteHarnessStore;
  kernel: HarnessKernel;
  service: InProcessHarnessService;
  model: RecordingFakeModelAdapter;
}

export async function createMemoryTestHarness(options: {
  model?: RecordingFakeModelAdapter;
  models?: ModelAdapter[];
  tools?: HarnessTool[];
  plugins?: HarnessPlugin[];
  executionProviders?: ExecutionProvider[];
  liveOutput?: LiveOutputSink;
  toolOutputPresenterFactory?: ToolOutputPresenterFactory;
} = {}): Promise<TestHarness> {
  const store = new MemoryHarnessStore();
  return createHarnessFromStore(store, options);
}

export async function createTempSqliteTestHarness(options: {
  model?: RecordingFakeModelAdapter;
  models?: ModelAdapter[];
  tools?: HarnessTool[];
  plugins?: HarnessPlugin[];
  executionProviders?: ExecutionProvider[];
  liveOutput?: LiveOutputSink;
  toolOutputPresenterFactory?: ToolOutputPresenterFactory;
} = {}): Promise<TestHarness & { dbPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-test-"));
  const dbPath = path.join(dir, "harness.sqlite");
  const store = await openSqliteHarnessStore({ dbPath, migrate: true });
  const harness = await createHarnessFromStore(store, options);
  return { ...harness, dbPath };
}

export async function createSqliteTestHarnessAtPath(dbPath: string, options: {
  model?: RecordingFakeModelAdapter;
  models?: ModelAdapter[];
  tools?: HarnessTool[];
  plugins?: HarnessPlugin[];
  executionProviders?: ExecutionProvider[];
  liveOutput?: LiveOutputSink;
  toolOutputPresenterFactory?: ToolOutputPresenterFactory;
} = {}): Promise<TestHarness & { dbPath: string }> {
  const store = await openSqliteHarnessStore({ dbPath, migrate: true });
  const harness = await createHarnessFromStore(store, options);
  return { ...harness, dbPath };
}

async function createHarnessFromStore(store: MemoryHarnessStore | SqliteHarnessStore, options: {
  model?: RecordingFakeModelAdapter;
  models?: ModelAdapter[];
  tools?: HarnessTool[];
  plugins?: HarnessPlugin[];
  executionProviders?: ExecutionProvider[];
  liveOutput?: LiveOutputSink;
  toolOutputPresenterFactory?: ToolOutputPresenterFactory;
}): Promise<TestHarness> {
  const model = options.model ?? new RecordingFakeModelAdapter();
  const kernel = new HarnessKernel({
    store,
    profileResolver: createProfileResolver(store),
    model,
    ...(options.models ? { models: options.models } : {}),
    tools: options.tools ?? createBasicTools(),
    executionProviders: options.executionProviders ?? [new FakeExecutionProvider(), createHostExecutionProvider()],
    plugins: options.plugins ?? [createBasicToolsPlugin(), createControlPlugin(), createTasksPlugin(), createSubagentsPlugin(), createMcpPlugin()],
    ...(options.liveOutput ? { liveOutput: options.liveOutput } : {}),
    ...(options.toolOutputPresenterFactory ? { toolOutputPresenterFactory: options.toolOutputPresenterFactory } : {})
  });
  await kernel.recoverRuntimeState();
  const taskManager = new TaskManager(kernel);
  const subagents = new SubagentDelegator(kernel);
  const service = new InProcessHarnessService({
    kernel,
    tasks: { addTask: (conversationId, title) => taskManager.addTask(conversationId, title) as unknown as Promise<JsonValue> },
    subagents
  });
  return { store, kernel, service, model };
}

function parseInlineToolCall(text: string): ToolCall | undefined {
  if (!text.includes("tool:bash")) {
    return undefined;
  }
  return {
    id: createId("call"),
    name: "bash",
    input: { command: "echo fake-tool" }
  };
}

function stateKey(conversationId: string, namespace: string): string {
  return `${conversationId}:${namespace}`;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
