import type { ActivityRecord, ActivityStatus, HarnessEvent, InteractionRequest, JsonValue, ToolCall, ToolResult, ToolExecutionRecord, ConversationRecord } from "@harness/protocol";
import type { ApprovalPolicyEngine } from "./approval-policy.ts";
import type { PluginHost } from "./plugins.ts";
import type { ExecutionContextRegistry } from "./execution.ts";
import { requireConversation, type HarnessStore } from "./store.ts";
import type { ToolExecutionIo, ToolExecutionOutcome, ToolRegistry } from "./tools.ts";
import type { LiveOutputSink, ToolOutputPresenterFactory } from "./live-output.ts";

// Forward declare kernel type to avoid import cycle problems if any
interface KernelLike {
  createActivity(input: {
    conversationId: string;
    turnId?: string;
    ownerPluginId: string;
    kind: string;
    label: string;
    status?: ActivityStatus;
    cancellable?: boolean;
    activityState?: JsonValue;
    onCompletion?: { delivery: "asap" | "after_active" | "manual" };
  }): Promise<ActivityRecord>;
  cancelActivity(activityId: string): Promise<void>;
  getActivityStatus(activityId: string): Promise<JsonValue>;
  completeActivity(activityId: string, result: JsonValue, status?: "completed" | "failed" | "cancelled"): Promise<ActivityRecord>;
  liveOutput: LiveOutputSink;
}

export class ToolScheduler {
  public constructor(
    private readonly kernel: KernelLike,
    private readonly store: HarnessStore,
    private readonly registry: ToolRegistry,
    private readonly contexts: ExecutionContextRegistry,
    private readonly plugins: PluginHost,
    private readonly approvalPolicy: ApprovalPolicyEngine,
    private readonly outputPresenterFactory: ToolOutputPresenterFactory,
    private readonly appendEvent: (input: {
      conversationId: string;
      turnId?: string;
      source?: { type: "context_build" | "tool_execution" | "activity" | "system"; id?: string };
      type: string;
      payload: JsonValue;
    }) => Promise<HarnessEvent>
  ) {}

  public async executeToolCall(conversationId: string, turnId: string, call: ToolCall, refs: { requestMessageId?: string; contextBuildId?: string } = {}): Promise<ToolExecutionOutcome & { toolExecutionId: string }> {
    const conversation = await requireConversation(this.store, conversationId);
    const filteredCall = await this.plugins.beforeToolCall({ conversation, call, effectiveProfile: conversation.effectiveProfile });

    if (!("blocked" in filteredCall) && filteredCall.id !== call.id) {
      const toolExecution = await this.store.createToolExecution({
        conversationId,
        turnId,
        ...(refs.requestMessageId ? { requestMessageId: refs.requestMessageId } : {}),
        ...(refs.contextBuildId ? { contextBuildId: refs.contextBuildId } : {}),
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        status: "running"
      });
      const result = blockedToolResult(call, "Tool call rewrite must preserve the original call id");
      await this.completeTool(conversationId, turnId, toolExecution.id, call, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }

    const toolExecution = await this.store.createToolExecution({
      conversationId,
      turnId,
      ...(refs.requestMessageId ? { requestMessageId: refs.requestMessageId } : {}),
      ...(refs.contextBuildId ? { contextBuildId: refs.contextBuildId } : {}),
      toolCallId: "blocked" in filteredCall ? call.id : filteredCall.id,
      toolName: "blocked" in filteredCall ? call.name : filteredCall.name,
      input: "blocked" in filteredCall ? call.input : filteredCall.input,
      status: "running"
    });

    const sourceRef = { type: "tool_execution" as const, id: toolExecution.id };

    await this.appendEvent({
      conversationId,
      turnId,
      source: sourceRef,
      type: "tool.started",
      payload: { toolExecutionId: toolExecution.id, toolCallId: toolExecution.toolCallId, toolName: toolExecution.toolName }
    });

    if ("blocked" in filteredCall) {
      const result = blockedToolResult(call, filteredCall.reason);
      await this.completeTool(conversationId, turnId, toolExecution.id, call, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }

    const tool = this.registry.get(filteredCall.name);
    if (!tool) {
      const result = blockedToolResult(filteredCall, `Tool ${filteredCall.name} is not registered`);
      await this.completeTool(conversationId, turnId, toolExecution.id, filteredCall, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }

    if (!conversation.effectiveProfile.config.enabledTools.includes(tool.name)) {
      const result = blockedToolResult(filteredCall, `Tool ${tool.name} is not enabled by the effective profile`);
      await this.completeTool(conversationId, turnId, toolExecution.id, filteredCall, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }

    if (tool.visibility === "ui") {
      const result = blockedToolResult(filteredCall, `Tool ${tool.name} is UI-only and cannot be called by the model`);
      await this.completeTool(conversationId, turnId, toolExecution.id, filteredCall, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }

    const approval = await this.approvalPolicy.evaluateToolCall({ conversation, turnId, call: filteredCall, tool, effectiveProfile: conversation.effectiveProfile });
    if (approval.decision === "denied") {
      const result = blockedToolResult(filteredCall, approval.reason);
      await this.completeTool(conversationId, turnId, toolExecution.id, filteredCall, result);
      return { status: "completed", result, toolExecutionId: toolExecution.id };
    }
    if (approval.decision === "needs_interaction") {
      const interaction = await this.store.createInteractionRequest({
        conversationId,
        turnId,
        toolExecutionId: toolExecution.id,
        origin: "approval",
        kind: "approval",
        prompt: approval.prompt,
        requestedSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" }
          },
          required: ["approved"]
        }
      });
      await this.store.updateToolExecution({
        id: toolExecution.id,
        status: "waiting",
        pendingInteractionIds: [interaction.id],
        resumeState: { kind: "approval", call: filteredCall as unknown as JsonValue }
      });
      await this.appendEvent({
        conversationId,
        turnId,
        source: sourceRef,
        type: "approval.requested",
        payload: { interactionId: interaction.id, toolCallId: filteredCall.id, toolExecutionId: toolExecution.id }
      });
      return { status: "waiting", interactionIds: [interaction.id], resumeState: { kind: "approval", call: filteredCall as unknown as JsonValue }, toolExecutionId: toolExecution.id };
    }

    const outcome = await this.executeApprovedTool(conversationId, turnId, toolExecution, filteredCall, tool, conversation);
    return { ...outcome, toolExecutionId: toolExecution.id };
  }

  public async resumeToolExecution(conversationId: string, turnId: string, toolExec: ToolExecutionRecord): Promise<ToolExecutionOutcome> {
    const conversation = await requireConversation(this.store, conversationId);
    const sourceRef = { type: "tool_execution" as const, id: toolExec.id };

    const tool = this.registry.get(toolExec.toolName);
    if (!tool) {
      const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, `Tool ${toolExec.toolName} is not registered`);
      await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
      return { status: "completed", result };
    }

    const isApproval = isApprovalResumeState(toolExec.resumeState);
    if (!tool.resume && !isApproval) {
      const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, `Tool ${toolExec.toolName} cannot resume a waiting execution`);
      await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
      return { status: "completed", result };
    }

    const interactions = await Promise.all(toolExec.pendingInteractionIds.map(async (id): Promise<InteractionRequest> => {
      const interaction = await this.store.getInteractionRequest(id);
      if (!interaction) {
        throw new Error(`Interaction ${id} not found for tool execution ${toolExec.id}`);
      }
      return interaction;
    }));

    const pending = interactions.filter((interaction) => interaction.status === "pending");
    if (pending.length > 0) {
      return { status: "waiting", interactionIds: pending.map((interaction) => interaction.id), ...(toolExec.resumeState === undefined ? {} : { resumeState: toolExec.resumeState }) };
    }

    await this.store.updateToolExecution({ id: toolExec.id, status: "running" });
    await this.appendEvent({
      conversationId,
      turnId,
      source: sourceRef,
      type: "tool.resumed",
      payload: { toolExecutionId: toolExec.id, interactionIds: toolExec.pendingInteractionIds }
    });

    if (isApproval) {
      const approved = interactions.every((interaction) => interaction.status === "accepted" && approvalResponseApproved(interaction.response));
      if (!approved) {
        const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, `Approval declined for tool ${toolExec.toolName}`);
        await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
        return { status: "completed", result };
      }
      return this.executeApprovedTool(conversationId, turnId, toolExec, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, tool, conversation);
    }

    if (!tool.resume) {
      const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, `Tool ${toolExec.toolName} cannot resume a waiting execution`);
      await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
      return { status: "completed", result };
    }

    const runtime = tool.requiresExecutionContext ? await this.contexts.resolveRuntime(conversationId) : undefined;
    const io = this.createToolIo(conversationId, turnId, toolExec.id, toolExec.toolName, toolExec.toolCallId);
    let outcome: ToolExecutionOutcome;
    try {
      outcome = normalizeToolOutcome(await tool.resume({
        call: { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input },
        conversation,
        activity: undefined,
        runtime,
        io,
        ...(toolExec.resumeState === undefined ? {} : { resumeState: toolExec.resumeState }),
        interactions
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, message);
      await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
      return { status: "completed", result };
    }
    if (await this.toolExecutionWasCancelled(toolExec.id)) {
      const result = blockedToolResult({ id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, `Tool execution ${toolExec.id} was cancelled`);
      await this.completeTool(conversationId, turnId, toolExec.id, { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input }, result);
      return { status: "completed", result };
    }

    if (outcome.status === "waiting") {
      await this.waitToolExecution(toolExec.id, conversationId, turnId, outcome);
      return outcome;
    }

    const call = { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input };
    const result = await this.completeTool(conversationId, turnId, toolExec.id, call, outcome.result);
    await this.plugins.afterToolResult({ conversation, call, result, effectiveProfile: conversation.effectiveProfile });
    return { status: "completed", result };
  }

  public async cancelToolExecution(conversationId: string, turnId: string, toolExec: ToolExecutionRecord, reason: string): Promise<ToolResult> {
    if (toolExec.conversationId !== conversationId || toolExec.turnId !== turnId) {
      throw new Error(`ToolExecution ${toolExec.id} does not belong to turn ${turnId}`);
    }
    const call = { id: toolExec.toolCallId, name: toolExec.toolName, input: toolExec.input };
    const result = withCreatedActivityRefs(blockedToolResult(call, reason), toolExec.createdActivityIds);
    await this.store.finalizeToolExecution({ conversationId, turnId, toolExecutionId: toolExec.id, call, status: "cancelled", result });
    return result;
  }

  private async executeApprovedTool(
    conversationId: string,
    turnId: string,
    toolExec: ToolExecutionRecord,
    call: ToolCall,
    tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
    conversation: ConversationRecord
  ): Promise<ToolExecutionOutcome> {
    const runtime = tool.requiresExecutionContext ? await this.contexts.resolveRuntime(conversationId) : undefined;
    const io = this.createToolIo(conversationId, turnId, toolExec.id, toolExec.toolName, toolExec.toolCallId);

    try {
      const outcome = normalizeToolOutcome(await tool.execute({ call, conversation, activity: undefined, runtime, io }));
      if (await this.toolExecutionWasCancelled(toolExec.id)) {
        const result = blockedToolResult(call, `Tool execution ${toolExec.id} was cancelled`);
        await this.completeTool(conversationId, turnId, toolExec.id, call, result);
        return { status: "completed", result };
      }
      if (outcome.status === "waiting") {
        await this.waitToolExecution(toolExec.id, conversationId, turnId, outcome);
        return outcome;
      }
      const result = await this.completeTool(conversationId, turnId, toolExec.id, call, outcome.result);
      await this.plugins.afterToolResult({ conversation, call, result, effectiveProfile: conversation.effectiveProfile });
      return { status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = blockedToolResult(call, message);
      await this.completeTool(conversationId, turnId, toolExec.id, call, result);
      return { status: "completed", result };
    }
  }

  private createToolIo(conversationId: string, turnId: string, toolExecutionId: string, toolName: string, callId: string): ToolExecutionIo {
    const source = { type: "tool_execution" as const, id: toolExecutionId };
    return {
      openLiveOutput: async (input) => {
        if (input.activityId) {
          await this.requireToolOwnedActivity(toolExecutionId, input.activityId);
        }
        return this.kernel.liveOutput.openChannel({
          conversationId,
          turnId,
          source: input.activityId ? { type: "activity", id: input.activityId } : source,
          ...(input.activityId ? { activityId: input.activityId } : {}),
          toolExecutionId,
          name: input.name,
          kind: input.kind
        });
      },
      peekActivityOutput: async (activityId, input) => {
        await this.requireConversationActivity(conversationId, activityId);
        return this.kernel.liveOutput.peek({ conversationId, activityId }, input);
      },
      createOutputPresenter: (input) => {
        return this.outputPresenterFactory({
          toolName,
          callId,
          ...(input?.metadata ? { metadata: input.metadata } : {})
        });
      },
      createAsset: async (input) => {
        const asset = await this.store.createAsset({ conversationId, turnId, source, ...input });
        await this.appendEvent({
          conversationId,
          turnId,
          source,
          type: "asset.created",
          payload: { assetId: asset.id, mimeType: asset.mimeType, byteSize: asset.byteSize, origin: asset.origin }
        });
        await this.store.createContextBlock({
          conversationId,
          turnId,
          source,
          kind: "asset_ref",
          content: [asset.mimeType.startsWith("image/") ? { type: "image_ref", assetId: asset.id } : { type: "file_ref", assetId: asset.id, mediaType: asset.mimeType }],
          data: { assetId: asset.id, mimeType: asset.mimeType, byteSize: asset.byteSize }
        });
        return asset;
      },
      createArtifact: async (input) => {
        const artifact = await this.store.createArtifact({ conversationId, turnId, source, ...input });
        await this.appendEvent({
          conversationId,
          turnId,
          source,
          type: "artifact.created",
          payload: { artifactId: artifact.id, kind: artifact.kind }
        });
        await this.store.createContextBlock({
          conversationId,
          turnId,
          source,
          kind: "artifact_ref",
          content: [{ type: "artifact_ref", artifactId: artifact.id, label: artifact.kind }],
          data: { artifactId: artifact.id, kind: artifact.kind }
        });
        return artifact;
      },
      createInteraction: async (input) => {
        const interaction = await this.store.createInteractionRequest({
          conversationId,
          turnId,
          toolExecutionId,
          origin: input.origin ?? "tool",
          kind: input.kind,
          prompt: input.prompt,
          ...(input.requestedSchema === undefined ? {} : { requestedSchema: input.requestedSchema }),
          ...(input.render === undefined ? {} : { render: input.render })
        });
        await this.appendEvent({
          conversationId,
          turnId,
          source,
          type: "interaction.requested",
          payload: { interactionId: interaction.id, kind: interaction.kind, origin: interaction.origin }
        });
        return interaction;
      },
      createContextBlock: async (input) => {
        const block = await this.store.createContextBlock({ conversationId, turnId, source, ...input });
        await this.store.createContextBlockSource({ blockId: block.id, sourceKind: "tool_execution", sourceId: toolExecutionId });
        return block;
      },

      createActivity: async (input) => {
        const activity = await this.kernel.createActivity({ conversationId, turnId, ...input });
        const current = await this.store.getToolExecution(toolExecutionId);
        if (!current) {
          throw new Error(`ToolExecution ${toolExecutionId} not found while linking activity ${activity.id}`);
        }
        await this.store.updateToolExecution({
          id: toolExecutionId,
          createdActivityIds: [...new Set([...current.createdActivityIds, activity.id])]
        });
        return activity;
      },
      completeActivity: async (id, result, status) => {
        await this.requireToolOwnedActivity(toolExecutionId, id);
        return this.kernel.completeActivity(id, result, status);
      },
      getActivity: async (id) => {
        const activity = await this.store.getActivity(id);
        return activity?.conversationId === conversationId ? activity : undefined;
      },
      cancelActivity: async (id) => {
        await this.requireConversationActivity(conversationId, id);
        return this.kernel.cancelActivity(id);
      },
      getActivityStatus: async (id) => {
        await this.requireConversationActivity(conversationId, id);
        return this.kernel.getActivityStatus(id);
      }
    };
  }

  private async requireConversationActivity(conversationId: string, activityId: string): Promise<ActivityRecord> {
    const activity = await this.store.getActivity(activityId);
    if (!activity || activity.conversationId !== conversationId) {
      throw new Error(`Activity ${activityId} is not available in conversation ${conversationId}`);
    }
    return activity;
  }

  private async requireToolOwnedActivity(toolExecutionId: string, activityId: string): Promise<ActivityRecord> {
    const execution = await this.requireToolExecution(toolExecutionId);
    const activity = await this.requireConversationActivity(execution.conversationId, activityId);
    if (!execution.createdActivityIds.includes(activityId)) {
      throw new Error(`Activity ${activityId} was not created by tool execution ${toolExecutionId}`);
    }
    return activity;
  }

  private async requireToolExecution(toolExecutionId: string): Promise<ToolExecutionRecord> {
    const execution = await this.store.getToolExecution(toolExecutionId);
    if (!execution) {
      throw new Error(`ToolExecution ${toolExecutionId} not found`);
    }
    return execution;
  }

  private async waitToolExecution(
    toolExecutionId: string,
    conversationId: string,
    turnId: string,
    outcome: Extract<ToolExecutionOutcome, { status: "waiting" }>
  ): Promise<void> {
    const sourceRef = { type: "tool_execution" as const, id: toolExecutionId };
    const current = await this.store.getToolExecution(toolExecutionId);
    if (!current) {
      throw new Error(`ToolExecution ${toolExecutionId} not found`);
    }
    await this.store.updateToolExecution({
      id: toolExecutionId,
      status: "waiting",
      pendingInteractionIds: outcome.interactionIds,
      resumeState: outcome.resumeState ?? null,
      createdActivityIds: [...new Set([...current.createdActivityIds, ...(outcome.activityIds ?? [])])]
    });
    await this.appendEvent({
      conversationId,
      turnId,
      source: sourceRef,
      type: "tool.waiting",
      payload: { toolExecutionId, interactionIds: outcome.interactionIds }
    });
  }

  private async completeTool(conversationId: string, turnId: string, toolExecutionId: string, call: ToolCall, result: ToolResult): Promise<ToolResult> {
    const toolExecution = await this.store.getToolExecution(toolExecutionId);
    if (!toolExecution) {
      throw new Error(`ToolExecution ${toolExecutionId} not found`);
    }
    const normalizedResult = result.toolCallId === call.id
      ? result
      : blockedToolResult(call, `Tool ${call.name} returned a result for ${result.toolCallId}, expected ${call.id}`);
    const resultWithActivityRefs = withCreatedActivityRefs(normalizedResult, toolExecution.createdActivityIds);
    const executionStatus = toolExecution.status === "cancelled"
      ? "cancelled"
      : resultWithActivityRefs.status === "ok" ? "completed" : "failed";
    await this.store.finalizeToolExecution({ conversationId, turnId, toolExecutionId, call, status: executionStatus, result: resultWithActivityRefs });
    return resultWithActivityRefs;
  }

  private async toolExecutionWasCancelled(toolExecutionId: string): Promise<boolean> {
    return (await this.store.getToolExecution(toolExecutionId))?.status === "cancelled";
  }
}

function normalizeToolOutcome(output: ToolResult | ToolExecutionOutcome): ToolExecutionOutcome {
  if ("result" in output || ("status" in output && output.status === "waiting")) {
    return output as ToolExecutionOutcome;
  }
  return { status: "completed", result: output as ToolResult };
}

function isApprovalResumeState(value: JsonValue | undefined): boolean {
  return isRecord(value) && value.kind === "approval";
}

function approvalResponseApproved(response: JsonValue | undefined): boolean {
  return isRecord(response) && response.approved === true;
}

function blockedToolResult(call: ToolCall, reason: string): ToolResult {
  return {
    toolCallId: call.id,
    status: "error",
    content: [{ type: "text", text: reason }],
    assetIds: [],
    artifactIds: [],
    summary: reason
  };
}

function withCreatedActivityRefs(result: ToolResult, activityIds: string[]): ToolResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
