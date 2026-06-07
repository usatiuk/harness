import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { modelStepResultSchema } from "@harness/protocol";
import type {
  ActivityRecord,
  ArtifactRecord,
  AssetOrigin,
  AssetRecord,
  ContentBlock,
  ContextBlock,
  ContextBuild,
  ExecutionContextRecord,
  HarnessEvent,
  InteractionRequest,
  JsonValue,
  MessageRecord,
  MessageRole,
  ModelStepResult,
  ProfileConfig,
  ProfileRecord,
  ProviderEventPayload,
  ProviderResumeState,
  ConversationRecord,
  StateNamespaceRecord,
  ToolCall,
  ConversationInputRecord,
  ConversationInputSource,
  ConversationInputTarget,
  ToolExecutionRecord,
  ToolResult,
  TurnState,
  TurnStatePhase,
  TurnRecord,
  WorkspaceRecord,
  SourceRef
} from "@harness/protocol";
import { isActiveActivity } from "./activities.ts";
import { ApprovalPolicyEngine } from "./approval-policy.ts";
import { ModelContextBuilder } from "./model-context.ts";
import type { ModelAdapter, ModelOutputObserver } from "./model.ts";
import { ModelRegistry, createModelRegistry } from "./model.ts";
import {
  createDefaultToolOutputPresenter,
  InMemoryLiveOutputSink,
  type LiveOutputSink,
  type OutputPeekOptions,
  type OutputPreview,
  type ToolOutputPresenterFactory
} from "./live-output.ts";
import { PluginHost, type HarnessPlugin } from "./plugins.ts";
import type { EffectiveProfileResolver } from "./profile.ts";
import { ExecutionContextRegistry, type ExecutionProvider } from "./execution.ts";
import { requireConversation, type HarnessStore, type PageRequest } from "./store.ts";
import { ToolScheduler } from "./tool-scheduler.ts";
import { ToolRegistry, type HarnessTool } from "./tools.ts";

export interface HarnessKernelOptions {
  store: HarnessStore;
  profileResolver: EffectiveProfileResolver;
  model?: ModelAdapter;
  models?: ModelAdapter[] | ModelRegistry;
  tools?: HarnessTool[];
  executionProviders?: ExecutionProvider[];
  plugins?: HarnessPlugin[];
  liveOutput?: LiveOutputSink;
  toolOutputPresenterFactory?: ToolOutputPresenterFactory;
}

export class HarnessKernel {
  public readonly tools = new ToolRegistry();
  public readonly plugins: PluginHost;
  public readonly contexts: ExecutionContextRegistry;
  public readonly modelContextBuilder: ModelContextBuilder;
  public readonly toolScheduler: ToolScheduler;
  public readonly approvalPolicy: ApprovalPolicyEngine;
  public readonly models: ModelRegistry;
  public readonly liveOutput: LiveOutputSink;
  private readonly conversationTurnStartQueues = new Map<string, Promise<unknown>>();
  private readonly turnContinuationQueues = new Map<string, Promise<unknown>>();

  public constructor(public readonly options: HarnessKernelOptions) {
    this.models = options.models instanceof ModelRegistry
      ? options.models
      : createModelRegistry(options.models ?? []);
    if (options.model) {
      this.models.register(options.model);
    }
    for (const tool of options.tools ?? []) {
      this.tools.register(tool);
    }
    this.plugins = new PluginHost(options.plugins ?? []);
    for (const plugin of options.plugins ?? []) {
      if ("setKernel" in plugin && typeof (plugin as any).setKernel === "function") {
        (plugin as any).setKernel(this);
      }
    }
    this.contexts = new ExecutionContextRegistry(options.store);
    for (const provider of options.executionProviders ?? []) {
      this.contexts.register(provider);
    }
    this.liveOutput = options.liveOutput ?? new InMemoryLiveOutputSink();
    this.approvalPolicy = new ApprovalPolicyEngine(this.plugins);
    this.modelContextBuilder = new ModelContextBuilder(options.store, this.tools, this.plugins, this.contexts);
    this.toolScheduler = new ToolScheduler(
      this,
      options.store,
      this.tools,
      this.contexts,
      this.plugins,
      this.approvalPolicy,
      options.toolOutputPresenterFactory ?? (() => createDefaultToolOutputPresenter()),
      (event) => this.appendEvent(event)
    );
  }

  public get store(): HarnessStore {
    return this.options.store;
  }

  public async recoverRuntimeState(): Promise<void> {
    const conversations = await this.store.listConversations();
    for (const conversation of conversations) {
      const interactions = await this.store.listInteractionRequests(conversation.id);
      const pendingInteractionIds = new Set(interactions.filter((interaction) => interaction.status === "pending").map((interaction) => interaction.id));
      const activities = await this.store.listActivities(conversation.id);

      for (const activity of activities) {
        const hasPendingInteraction = interactions.some((interaction) => interaction.status === "pending" && interaction.activityId === activity.id);
        if (activity.status === "queued" || activity.status === "running" || (activity.status === "waiting" && !hasPendingInteraction)) {
          const reason = `Activity ${activity.id} was abandoned during runtime restart`;
          await this.store.updateActivity({
            id: activity.id,
            status: "failed",
            result: { recovered: true, reason, summary: reason }
          });
          await this.appendEvent({
            conversationId: activity.conversationId,
            ...(activity.turnId ? { turnId: activity.turnId } : {}),
            source: { type: "activity", id: activity.id },
            type: "activity.failed",
            payload: { activityId: activity.id, recovered: true, reason }
          });
        }
      }

      const executions = await this.store.listToolExecutions(conversation.id);
      for (const execution of executions) {
        if (execution.status === "running") {
          await this.finalizeRecoveredToolExecution(execution, `Tool execution ${execution.id} was abandoned during runtime restart`);
          continue;
        }
        if (execution.status === "waiting" && !toolExecutionHasValidPendingState(execution, pendingInteractionIds)) {
          await this.finalizeRecoveredToolExecution(execution, `Tool execution ${execution.id} was waiting without valid pending interaction state after restart`);
        }
      }

      const turns = await this.store.listTurns(conversation.id);
      const recoveredActivities = await this.store.listActivities(conversation.id);
      const recoveredExecutions = await this.store.listToolExecutions(conversation.id);
      for (const turn of turns.filter((item) => item.status === "waiting")) {
        if (turnHasValidPendingState(turn, interactions, recoveredExecutions, recoveredActivities)) {
          await this.store.updateConversation({ id: conversation.id, status: "waiting" });
          continue;
        }
        const reason = `Waiting turn ${turn.id} has no valid pending state after runtime restart`;
        await this.writeTurnState({
          conversationId: conversation.id,
          turnId: turn.id,
          phase: "failed",
          loopState: { recovered: true, reason }
        });
        await this.store.updateTurn({ id: turn.id, status: "failed" });
        await this.store.updateConversation({ id: conversation.id, status: "failed" });
        await this.appendEvent({
          conversationId: conversation.id,
          turnId: turn.id,
          type: "turn.failed",
          payload: { turnId: turn.id, recovered: true, reason }
        });
      }
    }
  }

  public async createProfile(input: { name: string; config: ProfileConfig }): Promise<ProfileRecord> {
    this.models.resolve(input.config.model);
    return this.store.createProfile(input);
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    return this.store.listProfiles();
  }

  public async getProfile(idOrName: string): Promise<ProfileRecord | undefined> {
    return (await this.store.getProfile(idOrName)) ?? this.store.getProfileByName(idOrName);
  }

  public async selectProfile(idOrName: string): Promise<ProfileRecord> {
    const profile = await this.getProfile(idOrName);
    if (!profile) {
      throw new Error(`Profile ${idOrName} not found`);
    }
    this.models.resolve(profile.config.model);
    await this.store.setDefaultProfileId(profile.id);
    return profile;
  }

  public async createConversation(input: {
    profileId?: string;
    profileName?: string;
    profileOverrides?: Partial<ProfileConfig>;
    parentConversationId?: string;
    executionContextId?: string;
    title?: string;
  }): Promise<ConversationRecord> {
    const profile = input.profileId ?? (input.profileName ? (await this.getProfile(input.profileName))?.id : undefined);
    const resolveInput: { profileId?: string; runOverrides?: Partial<ProfileConfig> } = {
      ...(profile ? { profileId: profile } : {}),
      ...(input.profileOverrides ? { runOverrides: input.profileOverrides } : {})
    };
    const effectiveProfile = await this.options.profileResolver.resolveProfile(resolveInput);
    this.models.resolve(effectiveProfile.config.model);
    const resolvedProfileId = profile ?? effectiveProfile.profileId;
    const conversation = await this.store.createConversation({
      effectiveProfile,
      ...(resolvedProfileId ? { profileId: resolvedProfileId } : {}),
      ...(input.parentConversationId ? { parentConversationId: input.parentConversationId } : {}),
      ...(input.executionContextId ? { executionContextId: input.executionContextId } : {}),
      ...(input.title ? { title: input.title } : {})
    });
    await this.appendEvent({
      conversationId: conversation.id,
      type: "conversation.created",
      payload: {
        conversationId: conversation.id,
        parentConversationId: conversation.parentConversationId ?? null,
        profileId: conversation.profileId ?? null,
        executionContextId: conversation.executionContextId ?? null
      }
    });
    await this.plugins.onConversationCreated({ conversation, effectiveProfile: conversation.effectiveProfile });
    return conversation;
  }

  public async sendConversationInput(input: {
    conversationId: string;
    content: ContentBlock[];
    delivery: "asap" | "after_active" | "manual";
    role?: MessageRole;
    target?: ConversationInputTarget;
    source?: ConversationInputSource;
    sourceRef?: SourceRef;
  }): Promise<ConversationInputRecord> {
    const queued = await this.store.enqueueConversationInput({
      conversationId: input.conversationId,
      source: input.source ?? sourceForRole(input.role ?? "user"),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      delivery: input.delivery,
      target: input.target ?? "before_next_model_step",
      role: input.role ?? "user",
      content: input.content
    });

    await this.appendEvent({
      conversationId: input.conversationId,
      type: "conversation.input.queued",
      payload: { inputId: queued.id, delivery: queued.delivery, target: queued.target }
    });

    if (input.delivery !== "manual") {
      await this.serializeConversationTurnStart(input.conversationId, async () => {
        const activeTurn = await this.store.getActiveTurn(input.conversationId);
        if (!activeTurn) {
          await this.startQueuedNextTurn(input.conversationId);
        }
      });
    }

    return queued;
  }

  public async beginTurn(conversationId: string): Promise<TurnRecord> {
    const turn = await this.store.createTurn({ conversationId, status: "running" });
    await this.store.updateConversation({ id: conversationId, status: "running" });
    await this.appendEvent({
      conversationId,
      turnId: turn.id,
      type: "turn.started",
      payload: { turnId: turn.id }
    });
    await this.writeTurnState({
      conversationId,
      turnId: turn.id,
      phase: "started",
      loopState: { status: "started" }
    });
    return turn;
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return this.store.listConversations();
  }

  public async getConversation(id: string): Promise<ConversationRecord | undefined> {
    return this.store.getConversation(id);
  }

  public async listTurns(conversationId: string): Promise<TurnRecord[]> {
    return this.store.listTurns(conversationId);
  }

  public async resumeTurn(turnId: string): Promise<TurnRecord> {
    return this.serializeTurnContinuation(turnId, () => this.resumeTurnUnlocked(turnId));
  }

  private async resumeTurnUnlocked(turnId: string): Promise<TurnRecord> {
    const turn = await this.requireTurn(turnId);
    if (isTerminalTurnStatus(turn.status)) {
      return turn;
    }
    const pending = (await this.store.listInteractionRequests(turn.conversationId)).filter((interaction) => interaction.turnId === turnId && interaction.status === "pending");
    if (pending.length > 0) {
      const latest = await this.store.getTurnState(turnId);
      await this.writeTurnState({
        conversationId: turn.conversationId,
        turnId,
        phase: "waiting_interaction",
        pendingToolCalls: latest?.pendingToolCalls ?? [],
        completedToolCallIds: latest?.completedToolCallIds ?? [],
        pendingInteractionIds: pending.map((interaction) => interaction.id),
        loopState: { reason: "pending_interactions" }
      });
      await this.store.updateTurn({ id: turnId, status: "waiting" });
      await this.store.updateConversation({ id: turn.conversationId, status: "waiting" });
      return this.requireTurn(turnId);
    }

    const latest = await this.store.getTurnState(turnId);
    if (latest && latest.pendingToolCalls.length > 0 && latest.completedToolCallIds.length < latest.pendingToolCalls.length) {
      const continuation = await this.continueToolBatch({
        conversationId: turn.conversationId,
        turn,
        toolCalls: latest.pendingToolCalls,
        completedToolCallIds: latest.completedToolCallIds
      });
      if (continuation.status === "waiting") {
        return this.requireTurn(turnId);
      }
      if (continuation.ranTool || await this.drainConversationInputs(turn.conversationId, turnId, "before_next_model_step")) {
        await this.runModelStep(turn.conversationId, turnId);
        return this.requireTurn(turnId);
      }
      return this.requireTurn(turnId);
    }

    if (await this.drainConversationInputs(turn.conversationId, turnId, "before_next_model_step")) {
      await this.runModelStep(turn.conversationId, turnId);
      return this.requireTurn(turnId);
    }

    await this.completeTurn(turn.conversationId, turnId);
    return this.requireTurn(turnId);
  }

  public async interruptTurn(turnId: string, reason?: string): Promise<TurnRecord> {
    const turn = await this.requireTurn(turnId);
    await this.appendEvent({
      conversationId: turn.conversationId,
      turnId,
      type: "turn.interrupt.requested",
      payload: { reason: reason ?? null }
    });
    const activities = await this.store.listActivities(turn.conversationId);
    for (const activity of activities.filter((item) => item.turnId === turnId && item.cancellable && (item.status === "running" || item.status === "waiting"))) {
      await this.cancelActivity(activity.id);
    }
    const toolExecutions = await this.store.listToolExecutions(turn.conversationId);
    for (const exec of toolExecutions.filter((exec) => exec.turnId === turnId && (exec.status === "running" || exec.status === "waiting"))) {
      await this.toolScheduler.cancelToolExecution(turn.conversationId, turnId, exec, reason ?? "Turn interrupted");
    }
    const interactions = await this.store.listInteractionRequests(turn.conversationId);
    for (const interaction of interactions.filter((item) => item.turnId === turnId && item.status === "pending")) {
      await this.store.updateInteractionRequest({ id: interaction.id, expectedStatus: "pending", status: "cancelled" });
      await this.appendEvent({
        conversationId: turn.conversationId,
        turnId,
        ...(interaction.toolExecutionId ? { source: { type: "tool_execution" as const, id: interaction.toolExecutionId } } : {}),
        type: "interaction.cancelled",
        payload: { interactionId: interaction.id, reason: reason ?? null }
      });
    }
    await this.writeTurnState({
      conversationId: turn.conversationId,
      turnId,
      phase: "interrupted",
      loopState: { reason: reason ?? null }
    });
    await this.store.updateTurn({ id: turnId, status: "cancelled" });
    await this.store.updateConversation({ id: turn.conversationId, status: "cancelled" });

    // Complete parent subagent activity if one exists
    const conversation = await this.store.getConversation(turn.conversationId);
    if (conversation && conversation.parentConversationId) {
      const parentActivities = await this.store.listActivities(conversation.parentConversationId);
      for (const act of parentActivities) {
        if (act.kind === "plugin.subagents.run" && (act.status === "running" || act.status === "queued" || act.status === "waiting")) {
          const state = act.activityState as { childConversationId?: string } | undefined;
          if (state && state.childConversationId === turn.conversationId) {
            await this.completeActivity(act.id, {
              status: "cancelled",
              childConversationId: turn.conversationId
            }, "cancelled");
          }
        }
      }
    }

    return this.requireTurn(turnId);
  }

  public async attachExecutionContext(conversationId: string, executionContextId: string): Promise<ConversationRecord> {
    const conversation = await this.store.updateConversation({ id: conversationId, executionContextId });
    await this.appendEvent({
      conversationId,
      type: "execution_context.bound",
      payload: { executionContextId }
    });
    return conversation;
  }

  public async createWorkspace(input: { kind: string; rootPath?: string; metadata?: Record<string, JsonValue> }): Promise<WorkspaceRecord> {
    return this.store.createWorkspace(input);
  }

  public async createExecutionContext(input: {
    conversationId?: string;
    workspaceId?: string;
    providerKind: string;
    cwd?: string;
    env?: Record<string, string>;
    providerConfig?: JsonValue;
  }): Promise<ExecutionContextRecord> {
    return this.store.createExecutionContext(input);
  }

  public async addMessage(input: {
    conversationId: string;
    turnId?: string;
    role: MessageRole;
    content: ContentBlock[];
    source?: SourceRef;
  }): Promise<MessageRecord> {
    const message = await this.store.createMessage(input);
    await this.appendEvent({
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.source ? { source: input.source } : {}),
      type: "message.created",
      payload: { messageId: message.id, role: input.role, content: input.content as unknown as JsonValue }
    });
    const block = await this.store.createContextBlock({
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.source ? { source: input.source } : {}),
      kind: "message",
      content: input.content,
      data: { messageId: message.id, role: input.role },
      metadata: { messageId: message.id, role: input.role }
    });
    await this.store.createContextBlockSource({ blockId: block.id, sourceKind: "message", sourceId: message.id });
    return message;
  }

  public async createActivity(input: {
    id?: string;
    conversationId: string;
    turnId?: string;
    parentActivityId?: string;
    ownerPluginId: string;
    kind: string;
    label: string;
    status?: ActivityRecord["status"];
    cancellable?: boolean;
    activityState?: JsonValue;
    onCompletion?: { delivery: "asap" | "after_active" | "manual" };
  }): Promise<ActivityRecord> {
    this.assertActivityCanBeCreated(input.ownerPluginId, input.kind);
    const activity = await this.store.createActivity(input);
    await this.appendEvent({
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      source: { type: "activity", id: activity.id },
      type: "activity.created",
      payload: { activityId: activity.id, ownerPluginId: activity.ownerPluginId, kind: activity.kind, status: activity.status }
    });
    return activity;
  }

  public async createAsset(input: {
    conversationId?: string;
    turnId?: string;
    messageId?: string;
    uri: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
    origin: AssetOrigin;
    metadata?: Record<string, JsonValue>;
    derivedFromAssetId?: string;
    source?: SourceRef;
  }): Promise<AssetRecord> {
    const asset = await this.store.createAsset(input);
    if (input.conversationId) {
      await this.appendEvent({
        conversationId: input.conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        type: "asset.created",
        payload: { assetId: asset.id, mimeType: asset.mimeType, byteSize: asset.byteSize, origin: asset.origin }
      });
      await this.store.createContextBlock({
        conversationId: input.conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        kind: "asset_ref",
        content: [contentBlockForAsset(asset.id, asset.mimeType, asset.metadata.filename)],
        data: { assetId: asset.id, mimeType: asset.mimeType, byteSize: asset.byteSize },
        metadata: asset.metadata
      });
    }
    return asset;
  }

  public async runModelStep(conversationId: string, turnId?: string): Promise<ModelStepResult> {
    const turn = turnId ? await this.requireTurn(turnId) : await this.ensureActiveTurn(conversationId);
    if (turn.conversationId !== conversationId) {
      throw new Error(`Turn ${turn.id} belongs to conversation ${turn.conversationId}, not ${conversationId}`);
    }
    if (isTerminalTurnStatus(turn.status)) {
      throw new Error(`Cannot run model step for ${turn.status} turn ${turn.id}`);
    }
    const conversation = await requireConversation(this.store, conversationId);
    const modelAdapter = this.models.resolve(conversation.effectiveProfile.config.model);
    await this.store.updateConversation({ id: conversationId, status: "running" });
    await this.store.updateTurn({ id: turn.id, status: "running" });
    await this.drainConversationInputs(conversationId, turn.id, "next_turn_state");
    await this.drainConversationInputs(conversationId, turn.id, "before_next_model_step");

    const modelInput = await this.modelContextBuilder.build(conversationId, turn.id, modelAdapter.capabilities());
    const sourceRef: SourceRef = modelInput.contextBuildId
      ? { type: "context_build", id: modelInput.contextBuildId }
      : { type: "system" };
    await this.writeTurnState({
      conversationId,
      turnId: turn.id,
      phase: "before_model",
      ...(modelInput.contextBuildId ? { contextBuildId: modelInput.contextBuildId } : {}),
      loopState: {
        messageCount: modelInput.messages.length,
        nativeTools: modelInput.modelConfig.nativeTools.filter((tool) => tool.enabled).map((tool) => tool.kind)
      }
    });
    await this.appendEvent({
      conversationId,
      turnId: turn.id,
      source: sourceRef,
      type: "model.context_built",
      payload: {
        contextBuildId: modelInput.contextBuildId ?? null,
        messageCount: modelInput.messages.length,
        unsupportedInputBlockCount: modelInput.unsupportedInputBlocks.length,
        availableTools: modelInput.availableTools.map((tool) => tool.name),
        nativeTools: modelInput.modelConfig.nativeTools.filter((tool) => tool.enabled).map((tool) => tool.kind)
      }
    });

    let modelTextOutput: ReturnType<LiveOutputSink["openChannel"]> | undefined;
    let liveModelText = "";
    let outputAppendQueue = Promise.resolve();
    const outputObserver: ModelOutputObserver = {
      onTextDelta: (delta) => {
        if (delta.length === 0) {
          return undefined;
        }
        liveModelText += delta;
        outputAppendQueue = outputAppendQueue.then(async () => {
          modelTextOutput ??= this.liveOutput.openChannel({ conversationId, turnId: turn.id, source: sourceRef, name: "assistant", kind: "model_text" });
          await modelTextOutput.append({ text: delta });
        });
        return outputAppendQueue;
      }
    };

    let result: ModelStepResult;
    try {
      result = modelStepResultSchema.parse(await modelAdapter.step(modelInput, outputObserver));
      await outputAppendQueue;
      assertUniqueToolCalls(result.toolCalls);
      const modelText = textFromContent(result.content);
      if (liveModelText.length > 0 && !modelText.startsWith(liveModelText)) {
        throw new Error("Model live text does not match the final assistant message");
      }
      await this.assertTurnCanContinue(turn.id);
    } catch (error) {
      await outputAppendQueue;
      if (error instanceof TurnCancelledError) {
        throw error;
      }
      const payload = modelFailurePayload(error);
      await this.writeTurnState({
        conversationId,
        turnId: turn.id,
        phase: "after_model",
        ...(modelInput.contextBuildId ? { contextBuildId: modelInput.contextBuildId } : {}),
        loopState: {
          status: "failed",
          model: {
            provider: modelInput.modelConfig.provider,
            adapter: modelInput.modelConfig.adapter,
            modelId: modelInput.modelConfig.modelId
          },
          error: payload
        }
      });
      await this.appendEvent({
        conversationId,
        turnId: turn.id,
        source: sourceRef,
        type: "model.failed",
        payload: {
          ...payload,
          model: {
            provider: modelInput.modelConfig.provider,
            adapter: modelInput.modelConfig.adapter,
            modelId: modelInput.modelConfig.modelId
          }
        }
      });
      await this.store.updateTurn({ id: turn.id, status: "failed" });
      await this.store.updateConversation({ id: conversationId, status: "failed" });
      throw error;
    }
    for (const providerEvent of result.providerEvents) {
      await this.appendProviderEvent(conversationId, turn.id, sourceRef, providerEvent);
    }

    await this.writeTurnState({
      conversationId,
      turnId: turn.id,
      phase: "after_model",
      ...(modelInput.contextBuildId ? { contextBuildId: modelInput.contextBuildId } : {}),
      pendingToolCalls: result.toolCalls,
      completedToolCallIds: [],
      ...(result.providerResumeState === undefined ? {} : { providerResumeState: result.providerResumeState }),
      loopState: { toolCallCount: result.toolCalls.length, providerEventCount: result.providerEvents.length }
    });

    const assistantMessage = await this.addMessage({
      conversationId,
      turnId: turn.id,
      role: "assistant",
      source: sourceRef,
      content: [
        ...result.content,
        ...result.toolCalls.map((call): ContentBlock => ({ type: "tool_call_ref", toolCallId: call.id, toolName: call.name, input: call.input }))
      ]
    });

    await this.appendEvent({
      conversationId,
      turnId: turn.id,
      source: sourceRef,
      type: "model.completed",
      payload: {
        contentBlockCount: result.content.length,
        toolCallCount: result.toolCalls.length,
        providerEventCount: result.providerEvents.length,
        usage: result.usage ?? null,
        cost: result.cost ?? null,
        metadata: result.metadata as unknown as JsonValue
      }
    });

    let shouldRunFollowupModelStep = await this.drainConversationInputs(conversationId, turn.id, "after_current_activity");
    if (result.usage !== undefined || result.cost !== undefined) {
      await this.appendEvent({
        conversationId,
        turnId: turn.id,
        source: sourceRef,
        type: "model.usage",
        payload: {
          usage: result.usage ?? null,
          cost: result.cost ?? null
        }
      });
    }

    const continuation = await this.continueToolBatch({
      conversationId,
      turn,
      toolCalls: result.toolCalls,
      completedToolCallIds: [],
      requestMessageId: assistantMessage.id,
      ...(modelInput.contextBuildId ? { contextBuildId: modelInput.contextBuildId } : {})
    });
    if (continuation.status === "waiting") {
      return result;
    }
    shouldRunFollowupModelStep ||= continuation.ranTool;
    if (shouldRunFollowupModelStep || await this.drainConversationInputs(conversationId, turn.id, "before_next_model_step")) {
      return this.runModelStep(conversationId, turn.id);
    }
    await this.completeTurn(conversationId, turn.id);
    return result;
  }

  private async continueToolBatch(input: {
    conversationId: string;
    turn: TurnRecord;
    toolCalls: ToolCall[];
    completedToolCallIds: string[];
    requestMessageId?: string;
    contextBuildId?: string;
  }): Promise<{ status: "waiting" } | { status: "completed"; completedToolCallIds: string[]; ranTool: boolean }> {
    let completedToolCallIds = [...input.completedToolCallIds];
    let ranTool = false;
    for (const call of input.toolCalls) {
      if (completedToolCallIds.includes(call.id)) {
        continue;
      }

      await this.writeTurnState({
        conversationId: input.conversationId,
        turnId: input.turn.id,
        phase: "before_tool",
        pendingToolCalls: input.toolCalls,
        completedToolCallIds,
        loopState: { toolCallId: call.id, toolName: call.name }
      });

      const existing = await this.store.getToolExecutionByTurnAndToolCallId(input.turn.id, call.id);
      let toolExecutionId = existing?.id;
      let outcome: Awaited<ReturnType<ToolScheduler["executeToolCall"]>> | Awaited<ReturnType<ToolScheduler["resumeToolExecution"]>>;
      if (existing && existing.status === "waiting") {
        outcome = await this.toolScheduler.resumeToolExecution(input.conversationId, input.turn.id, existing);
      } else if (existing && isTerminalToolExecutionStatus(existing.status)) {
        if (!existing.result) {
          throw new Error(`Terminal tool execution ${existing.id} for call ${call.id} has no result`);
        }
        outcome = { status: "completed", result: existing.result };
      } else if (existing) {
        throw new Error(`Tool execution ${existing.id} for call ${call.id} is already ${existing.status}`);
      } else {
        const executeOutcome = await this.toolScheduler.executeToolCall(input.conversationId, input.turn.id, call, {
          ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
          ...(input.contextBuildId ? { contextBuildId: input.contextBuildId } : {})
        });
        outcome = executeOutcome;
        toolExecutionId = executeOutcome.toolExecutionId;
      }

      if (outcome.status === "waiting") {
        await this.writeTurnState({
          conversationId: input.conversationId,
          turnId: input.turn.id,
          phase: "waiting_interaction",
          ...(toolExecutionId ? { activeToolExecutionId: toolExecutionId } : {}),
          pendingToolCalls: input.toolCalls,
          completedToolCallIds,
          pendingInteractionIds: outcome.interactionIds,
          loopState: { resumeState: outcome.resumeState ?? null }
        });
        await this.store.updateTurn({ id: input.turn.id, status: "waiting" });
        await this.store.updateConversation({ id: input.conversationId, status: "waiting" });
        return { status: "waiting" };
      }

      await this.assertTurnCanContinue(input.turn.id);
      ranTool = true;
      completedToolCallIds = [...new Set([...completedToolCallIds, call.id])];
      await this.writeTurnState({
        conversationId: input.conversationId,
        turnId: input.turn.id,
        phase: "after_tool",
        ...(toolExecutionId ? { activeToolExecutionId: toolExecutionId } : {}),
        pendingToolCalls: input.toolCalls,
        completedToolCallIds,
        loopState: { toolCallId: call.id, status: outcome.result.status }
      });
      await this.drainConversationInputs(input.conversationId, input.turn.id, "after_next_tool");
      await this.drainConversationInputs(input.conversationId, input.turn.id, "after_current_activity");
    }
    return { status: "completed", completedToolCallIds, ranTool };
  }

  public async answerInteraction(id: string, response: JsonValue): Promise<InteractionRequest> {
    const current = await this.store.getInteractionRequest(id);
    if (!current) {
      throw new Error(`Interaction ${id} not found`);
    }
    if (current.status === "accepted" && jsonEqual(current.response, response)) {
      return current;
    }
    if (current.status !== "pending") {
      throw new Error(`Interaction ${id} is ${current.status}`);
    }
    const turn = await this.requireTurn(current.turnId);
    if (isTerminalTurnStatus(turn.status)) {
      throw new Error(`Interaction ${id} belongs to ${turn.status} turn ${turn.id}`);
    }
    validateInteractionResponse(current, response);
    let interaction: InteractionRequest;
    try {
      interaction = await this.store.updateInteractionRequest({ id, expectedStatus: "pending", status: "accepted", response });
    } catch (error) {
      const latest = await this.store.getInteractionRequest(id);
      if (latest?.status === "accepted" && jsonEqual(latest.response, response)) {
        return latest;
      }
      throw error;
    }
    await this.store.createContextBlock({
      conversationId: interaction.conversationId,
      turnId: interaction.turnId,
      ...(interaction.toolExecutionId ? { source: { type: "tool_execution", id: interaction.toolExecutionId } } : {}),
      kind: "interaction_result",
      content: [{ type: "interaction_ref", interactionId: interaction.id, label: interaction.kind }],
      data: { interactionId: interaction.id, status: interaction.status, response }
    });
    await this.appendEvent({
      conversationId: interaction.conversationId,
      turnId: interaction.turnId,
      ...(interaction.toolExecutionId ? { source: { type: "tool_execution", id: interaction.toolExecutionId } } : {}),
      type: "interaction.answered",
      payload: { interactionId: interaction.id, status: interaction.status }
    });
    await this.resumeTurn(interaction.turnId);
    return interaction;
  }

  public async cancelInteraction(id: string): Promise<InteractionRequest> {
    const current = await this.store.getInteractionRequest(id);
    if (!current) {
      throw new Error(`Interaction ${id} not found`);
    }
    if (current.status === "cancelled") {
      return current;
    }
    if (current.status !== "pending") {
      throw new Error(`Interaction ${id} is ${current.status}`);
    }
    const turn = await this.requireTurn(current.turnId);
    if (isTerminalTurnStatus(turn.status)) {
      throw new Error(`Interaction ${id} belongs to ${turn.status} turn ${turn.id}`);
    }
    let interaction: InteractionRequest;
    try {
      interaction = await this.store.updateInteractionRequest({ id, expectedStatus: "pending", status: "cancelled" });
    } catch (error) {
      const latest = await this.store.getInteractionRequest(id);
      if (latest?.status === "cancelled") {
        return latest;
      }
      throw error;
    }
    await this.appendEvent({
      conversationId: interaction.conversationId,
      turnId: interaction.turnId,
      ...(interaction.toolExecutionId ? { source: { type: "tool_execution", id: interaction.toolExecutionId } } : {}),
      type: "interaction.cancelled",
      payload: { interactionId: interaction.id }
    });
    await this.resumeTurn(interaction.turnId);
    return interaction;
  }

  public async createApprovalInteraction(input: {
    conversationId: string;
    turnId: string;
    toolExecutionId?: string;
    prompt: ContentBlock[];
    requestedSchema?: JsonValue;
  }): Promise<InteractionRequest> {
    const interaction = await this.store.createInteractionRequest({
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(input.toolExecutionId ? { toolExecutionId: input.toolExecutionId } : {}),
      origin: "approval",
      kind: "approval",
      prompt: input.prompt,
      ...(input.requestedSchema === undefined ? {} : { requestedSchema: input.requestedSchema })
    });
    await this.appendEvent({
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(input.toolExecutionId ? { source: { type: "tool_execution", id: input.toolExecutionId } } : {}),
      type: "approval.requested",
      payload: { interactionId: interaction.id }
    });
    return interaction;
  }

  public async runCompaction(conversationId: string): Promise<ContextBlock> {
    const blocks = await this.store.listContextBlocks(conversationId);
    const messages = await this.store.listMessages(conversationId, { limit: 1000 });
    const coveredThroughMessageSequence = messages.reduce((max, message) => Math.max(max, message.sequence), -1);
    const coveredThroughContextSequence = blocks.length;
    const summaryText = `Compacted ${blocks.length} context blocks and ${messages.length} messages.`;
    const block = await this.store.createContextBlock({
      conversationId,
      source: { type: "system" },
      kind: "projection",
      content: [{ type: "text", text: summaryText }],
      data: {
        blockCount: blocks.length,
        messageCount: messages.length,
        coveredThroughMessageSequence,
        coveredThroughContextSequence
      },
      coverageCursor: `messages:${coveredThroughMessageSequence};context:${coveredThroughContextSequence}`,
      metadata: {
        coveredThroughMessageSequence,
        coveredThroughContextSequence
      },
      policyId: "fake-summarizer-v0"
    });
    await this.appendEvent({
      conversationId,
      source: { type: "system" },
      type: "context.compaction.completed",
      payload: { blockId: block.id, coveredBlockCount: blocks.length }
    });
    return block;
  }

  public async updateStateNamespace(input: { conversationId: string; namespace: string; value: JsonValue }): Promise<StateNamespaceRecord> {
    const state = await this.store.upsertStateNamespace(input);
    await this.store.createContextBlock({
      conversationId: input.conversationId,
      kind: "state",
      content: [{ type: "data", label: input.namespace, data: input.value }],
      data: input.value,
      metadata: { namespace: input.namespace, version: state.version }
    });
    await this.appendEvent({
      conversationId: input.conversationId,
      type: "state.updated",
      payload: { namespace: input.namespace, version: state.version }
    });
    return state;
  }

  public async listEvents(conversationId: string, page?: PageRequest): Promise<HarnessEvent[]> {
    return this.store.listEvents(conversationId, page);
  }

  public async listActivities(conversationId: string): Promise<ActivityRecord[]> {
    return this.store.listActivities(conversationId);
  }

  public async peekActivityOutput(activityId: string, input?: OutputPeekOptions): Promise<OutputPreview | undefined> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) {
      throw new Error(`Activity ${activityId} not found`);
    }
    return this.liveOutput.peek({ conversationId: activity.conversationId, activityId }, input);
  }

  public async peekToolOutput(toolExecutionId: string, input?: OutputPeekOptions): Promise<OutputPreview | undefined> {
    const execution = await this.store.getToolExecution(toolExecutionId);
    if (!execution) {
      throw new Error(`ToolExecution ${toolExecutionId} not found`);
    }
    return this.liveOutput.peek({ conversationId: execution.conversationId, toolExecutionId }, input);
  }

  public async listAssets(conversationId?: string): Promise<AssetRecord[]> {
    return this.store.listAssets(conversationId);
  }

  public async listArtifacts(conversationId: string): Promise<ArtifactRecord[]> {
    return this.store.listArtifacts(conversationId);
  }

  public async listStateNamespaces(conversationId: string): Promise<StateNamespaceRecord[]> {
    return this.store.listStateNamespaces(conversationId);
  }

  public async listExecutionContexts(conversationId?: string): Promise<ExecutionContextRecord[]> {
    return this.store.listExecutionContexts(conversationId);
  }

  public async listPendingInteractions(conversationId?: string): Promise<InteractionRequest[]> {
    return this.store.listPendingInteractions(conversationId);
  }

  public async getInteraction(id: string): Promise<InteractionRequest | undefined> {
    return this.store.getInteractionRequest(id);
  }

  public async getTurnState(turnId: string): Promise<TurnState | undefined> {
    return this.store.getTurnState(turnId);
  }

  public async listContextBlocks(conversationId: string): Promise<ContextBlock[]> {
    return this.store.listContextBlocks(conversationId);
  }

  public async listContextBuilds(conversationId: string): Promise<ContextBuild[]> {
    return this.store.listContextBuilds(conversationId);
  }

  public async appendEvent(input: {
    conversationId: string;
    turnId?: string;
    source?: SourceRef;
    type: string;
    payload: JsonValue;
  }): Promise<HarnessEvent> {
    return this.store.appendEvent(input);
  }

  public async completeActivity(activityId: string, result: JsonValue, status: "completed" | "failed" | "cancelled" = "completed"): Promise<ActivityRecord> {
    const activity = await this.store.updateActivity({ id: activityId, status, result });
    await this.appendEvent({
      conversationId: activity.conversationId,
      source: { type: "activity", id: activityId },
      type: `activity.${status}`,
      payload: { activityId, result }
    });

    if (activity.onCompletion) {
      const driver = this.plugins.getActivityDriver(activity.ownerPluginId, activity.kind);
      const content = await driver?.summarizeCompletion?.(activity) ?? genericActivityCompletionContent(activity);

      await this.sendConversationInput({
        conversationId: activity.conversationId,
        content,
        delivery: activity.onCompletion.delivery,
        role: "system",
        source: "activity",
        sourceRef: { type: "activity", id: activity.id }
      });
    }

    // Resume turn if waiting on this activity
    const activeTurn = await this.store.getActiveTurn(activity.conversationId);
    if (activeTurn && activeTurn.status === "waiting") {
      await this.resumeTurn(activeTurn.id);
    }
    await this.settleConversationIfIdle(activity.conversationId);

    return activity;
  }

  public async getActivityStatus(activityId: string): Promise<JsonValue> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) {
      throw new Error(`Activity ${activityId} not found`);
    }
    const driver = this.plugins.getActivityDriver(activity.ownerPluginId, activity.kind);
    if (driver) {
      return driver.status(activity);
    }
    return { status: activity.status, result: activity.result ?? null };
  }

  public async cancelActivity(activityId: string): Promise<void> {
    const activity = await this.store.getActivity(activityId);
    if (!activity) {
      throw new Error(`Activity ${activityId} not found`);
    }
    if (activity.status === "cancelled" || activity.status === "completed" || activity.status === "failed") {
      return;
    }
    await this.store.updateActivity({ id: activityId, status: "cancelled" });
    const driver = this.plugins.getActivityDriver(activity.ownerPluginId, activity.kind);
    if (driver) {
      await driver.cancel(activity);
    }
    const current = await this.store.getActivity(activityId);
    if (current?.result !== undefined) {
      return;
    }
    await this.completeActivity(activityId, { summary: `Activity ${activity.label} was cancelled.` }, "cancelled");
  }

  private async finalizeRecoveredToolExecution(execution: ToolExecutionRecord, reason: string): Promise<void> {
    const call: ToolCall = { id: execution.toolCallId, name: execution.toolName, input: execution.input };
    const result = toolResultWithActivityRefs({
      toolCallId: execution.toolCallId,
      status: "error",
      content: [{ type: "text", text: reason }],
      data: { recovered: true, reason },
      assetIds: [],
      artifactIds: [],
      summary: reason
    }, execution.createdActivityIds);
    await this.store.finalizeToolExecution({
      conversationId: execution.conversationId,
      turnId: execution.turnId,
      toolExecutionId: execution.id,
      call,
      status: "failed",
      result
    });
  }

  private async appendProviderEvent(conversationId: string, turnId: string, source: SourceRef, payload: ProviderEventPayload): Promise<void> {
    await this.appendEvent({
      conversationId,
      turnId,
      source,
      type: "provider.event",
      payload: payload as unknown as JsonValue
    });
    await this.store.createContextBlock({
      conversationId,
      turnId,
      source,
      kind: "provider_event_summary",
      content: [{ type: "data", label: payload.kind, data: payload.normalized }],
      data: payload as unknown as JsonValue,
      metadata: { provider: payload.provider, modelId: payload.modelId, sequence: payload.sequence }
    });
  }

  private async ensureActiveTurn(conversationId: string): Promise<TurnRecord> {
    return (await this.store.getActiveTurn(conversationId)) ?? this.beginTurn(conversationId);
  }

  private async requireTurn(turnId: string): Promise<TurnRecord> {
    const turn = await this.store.getTurn(turnId);
    if (!turn) {
      throw new Error(`Turn ${turnId} not found`);
    }
    return turn;
  }

  private async completeTurn(conversationId: string, turnId: string): Promise<void> {
    await this.writeTurnState({
      conversationId,
      turnId,
      phase: "completed",
      loopState: { status: "completed" }
    });
    await this.store.updateTurn({ id: turnId, status: "completed" });
    await this.appendEvent({
      conversationId,
      turnId,
      type: "turn.completed",
      payload: { turnId }
    });
    await this.settleConversationIfIdle(conversationId, turnId);

    // Complete parent subagent activity if one exists
    const conversation = await this.store.getConversation(conversationId);
    if (conversation && conversation.parentConversationId) {
      const parentActivities = await this.store.listActivities(conversation.parentConversationId);
      for (const act of parentActivities) {
        if (act.kind === "plugin.subagents.run" && (act.status === "running" || act.status === "queued" || act.status === "waiting")) {
          const state = act.activityState as { childConversationId?: string } | undefined;
          if (state && state.childConversationId === conversationId) {
            await this.completeActivity(act.id, {
              status: "completed",
              childConversationId: conversationId
            }, "completed");
          }
        }
      }
    }
  }

  private async writeTurnState(input: {
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
    loopState: JsonValue;
  }): Promise<TurnState> {
    const state = await this.store.saveTurnState(input);
    await this.appendEvent({
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(input.activeToolExecutionId ? { source: { type: "tool_execution", id: input.activeToolExecutionId } } : {}),
      ...(input.activeActivityId ? { source: { type: "activity", id: input.activeActivityId } } : {}),
      ...(!input.activeToolExecutionId && !input.activeActivityId && input.contextBuildId ? { source: { type: "context_build" as const, id: input.contextBuildId } } : {}),
      type: "turn.state",
      payload: { turnStateId: state.id, phase: state.phase }
    });
    return state;
  }

  private async drainConversationInputs(conversationId: string, turnId: string, target: ConversationInputTarget): Promise<boolean> {
    const pending = await this.store.listConversationInputs({ conversationId, delivery: "asap", status: "pending" });
    const eligible = pending.filter((input) =>
      (input.turnId === undefined || input.turnId === turnId) &&
      (input.target === target || input.target === "next_turn_state")
    );
    if (eligible.length === 0) {
      return false;
    }
    const turn = await this.requireTurn(turnId);
    await this.consumeInputsIntoTurn(conversationId, turn, eligible);
    return true;
  }

  private async startQueuedNextTurn(conversationId: string): Promise<boolean> {
    const pending = await this.store.listConversationInputs({ conversationId, status: "pending" });
    const eligible = pending.filter((input) => input.delivery === "asap" || input.delivery === "after_active");
    if (eligible.length === 0) {
      return false;
    }
    const turn = await this.beginTurn(conversationId);
    await this.consumeInputsIntoTurn(conversationId, turn, eligible);
    await this.runModelStep(conversationId, turn.id);
    return true;
  }

  private async serializeConversationTurnStart<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationTurnStartQueues.get(conversationId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.conversationTurnStartQueues.set(conversationId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.conversationTurnStartQueues.get(conversationId) === current) {
        this.conversationTurnStartQueues.delete(conversationId);
      }
    }
  }

  private async serializeTurnContinuation<T>(turnId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.turnContinuationQueues.get(turnId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.turnContinuationQueues.set(turnId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.turnContinuationQueues.get(turnId) === current) {
        this.turnContinuationQueues.delete(turnId);
      }
    }
  }

  private async consumeInputsIntoTurn(conversationId: string, turn: TurnRecord, inputs: ConversationInputRecord[]): Promise<void> {
    const inputMessageIds = [...turn.inputMessageIds];
    for (const input of inputs) {
      const message = await this.addMessage({
        conversationId,
        turnId: turn.id,
        role: input.role,
        content: input.content,
        ...(input.sourceRef ? { source: input.sourceRef } : {})
      });
      inputMessageIds.push(message.id);
      await this.store.consumeConversationInput({ id: input.id, turnId: turn.id, consumedMessageId: message.id });
      await this.appendEvent({
        conversationId,
        turnId: turn.id,
        ...(input.sourceRef ? { source: input.sourceRef } : {}),
        type: "turn.input.consumed",
        payload: { inputId: input.id, messageId: message.id, delivery: input.delivery, target: input.target, source: input.source }
      });
    }
    await this.store.updateTurn({ id: turn.id, inputMessageIds });
  }

  private async assertTurnCanContinue(turnId: string): Promise<void> {
    const turn = await this.requireTurn(turnId);
    if (turn.status === "cancelled") {
      throw new TurnCancelledError(turnId);
    }
    if (turn.status === "failed" || turn.status === "completed") {
      throw new Error(`Turn ${turnId} is ${turn.status}`);
    }
  }

  private async settleConversationIfIdle(conversationId: string, turnId?: string): Promise<void> {
    if (await this.store.getActiveTurn(conversationId)) {
      return;
    }
    if (await this.hasAutoDeliverablePendingInput(conversationId)) {
      await this.serializeConversationTurnStart(conversationId, async () => {
        if (!await this.store.getActiveTurn(conversationId)) {
          await this.startQueuedNextTurn(conversationId);
        }
      });
      return;
    }
    const activeActivities = (await this.store.listActivities(conversationId)).filter(isActiveActivity);
    if (activeActivities.length > 0) {
      await this.store.updateConversation({ id: conversationId, status: "waiting" });
      return;
    }
    const conversation = await this.store.getConversation(conversationId);
    if (!conversation || conversation.status === "completed" || conversation.status === "cancelled" || conversation.status === "failed") {
      return;
    }
    await this.store.updateConversation({ id: conversationId, status: "completed" });
    await this.appendEvent({
      conversationId,
      ...(turnId ? { turnId } : {}),
      type: "conversation.completed",
      payload: { conversationId }
    });
  }

  private async hasAutoDeliverablePendingInput(conversationId: string): Promise<boolean> {
    const pending = await this.store.listConversationInputs({ conversationId, status: "pending" });
    return pending.some((input) => input.delivery === "asap" || input.delivery === "after_active");
  }

  private assertActivityCanBeCreated(ownerPluginId: string, kind: string): void {
    if (this.plugins.getActivityDriver(ownerPluginId, kind)) {
      return;
    }
    throw new Error(`No activity driver registered for ${ownerPluginId}/${kind}`);
  }
}

function sourceForRole(role: MessageRole): ConversationInputSource {
  return role === "user" ? "user" : "system";
}

function isTerminalTurnStatus(status: TurnRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalToolExecutionStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function toolExecutionHasValidPendingState(execution: ToolExecutionRecord, pendingInteractionIds: Set<string>): boolean {
  return execution.pendingInteractionIds.length > 0 && execution.pendingInteractionIds.every((id) => pendingInteractionIds.has(id));
}

function turnHasValidPendingState(
  turn: TurnRecord,
  interactions: InteractionRequest[],
  executions: ToolExecutionRecord[],
  activities: ActivityRecord[]
): boolean {
  const pendingInteractionIds = new Set(interactions.filter((interaction) => interaction.status === "pending").map((interaction) => interaction.id));
  if (interactions.some((interaction) => interaction.turnId === turn.id && interaction.status === "pending")) {
    return true;
  }
  if (executions.some((execution) =>
    execution.turnId === turn.id &&
    execution.status === "waiting" &&
    toolExecutionHasValidPendingState(execution, pendingInteractionIds)
  )) {
    return true;
  }
  return activities.some((activity) =>
    activity.turnId === turn.id &&
    activity.status === "waiting" &&
    interactions.some((interaction) => interaction.status === "pending" && interaction.activityId === activity.id)
  );
}

function toolResultWithActivityRefs(result: ToolResult, activityIds: string[]): ToolResult {
  if (activityIds.length === 0) {
    return result;
  }
  const existing = new Set(result.content.flatMap((block) => block.type === "activity_ref" ? [block.activityId] : []));
  const missing = activityIds.filter((activityId) => !existing.has(activityId));
  if (missing.length === 0) {
    return result;
  }
  return {
    ...result,
    content: [
      ...result.content,
      ...missing.map((activityId) => ({ type: "activity_ref" as const, activityId }))
    ]
  };
}

function textFromContent(content: ContentBlock[]): string {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function assertUniqueToolCalls(toolCalls: ToolCall[]): void {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (seen.has(call.id)) {
      throw new Error(`Model returned duplicate tool call id ${call.id}`);
    }
    seen.add(call.id);
  }
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class TurnCancelledError extends Error {
  public constructor(turnId: string) {
    super(`Turn ${turnId} was cancelled`);
    this.name = "TurnCancelledError";
  }
}

const interactionResponseAjv = new Ajv({ allErrors: true, strict: false });

function validateInteractionResponse(interaction: InteractionRequest, response: JsonValue): void {
  if (interaction.requestedSchema === undefined) {
    return;
  }
  if (!isJsonSchema(interaction.requestedSchema)) {
    throw new Error(`Interaction ${interaction.id} has a non-object response schema`);
  }
  let validate: ValidateFunction;
  try {
    validate = interactionResponseAjv.compile(interaction.requestedSchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Interaction ${interaction.id} has an invalid response schema: ${message}`);
  }
  if (!validate(response)) {
    throw new Error(`Interaction ${interaction.id} response does not match requested schema: ${interactionResponseAjv.errorsText(validate.errors)}`);
  }
}

function isJsonSchema(value: JsonValue): value is AnySchema {
  return typeof value === "boolean" || isRecord(value);
}

function genericActivityCompletionContent(activity: ActivityRecord): ContentBlock[] {
  const result = activity.result;
  if (typeof result === "object" && result !== null && !Array.isArray(result) && "summary" in result && typeof result.summary === "string") {
    return [{ type: "text", text: result.summary }];
  }
  return [{ type: "text", text: `Activity ${activity.label} (${activity.id}) finished with status ${activity.status}.` }];
}

function modelFailurePayload(error: unknown): Record<string, JsonValue> {
  const record = isRecord(error) ? error : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : typeof record.name === "string" ? record.name : "Error",
    requestId: stringOrNull(record.request_id ?? record.requestId),
    status: numberOrNull(record.status)
  };
}

function contentBlockForAsset(assetId: string, mimeType: string, filenameValue: JsonValue | undefined): ContentBlock {
  const filename = typeof filenameValue === "string" ? filenameValue : undefined;
  if (mimeType.startsWith("image/")) {
    return { type: "image_ref", assetId, ...(filename ? { alt: filename } : {}) };
  }
  if (mimeType === "application/pdf") {
    return { type: "pdf_ref", assetId, ...(filename ? { filename } : {}) };
  }
  return { type: "file_ref", assetId, ...(filename ? { filename } : {}), mediaType: mimeType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
