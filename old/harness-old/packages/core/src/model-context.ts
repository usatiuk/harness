import type {
  ContentBlock,
  ContextBlock,
  JsonValue,
  MessageRole,
  ModelCapabilities,
  ModelContextMessage,
  ModelStepInput
} from "@harness/protocol";
import type { ExecutionContextRegistry } from "./execution.ts";
import type { PluginHost } from "./plugins.ts";
import { requireConversation, type HarnessStore } from "./store.ts";
import type { ToolRegistry } from "./tools.ts";

export const DEFAULT_CONTEXT_POLICY_ID = "deterministic-v0";

export class ModelContextBuilder {
  public constructor(
    private readonly store: HarnessStore,
    private readonly tools: ToolRegistry,
    private readonly plugins: PluginHost,
    private readonly contexts: ExecutionContextRegistry
  ) {}

  public async build(conversationId: string, turnId: string, capabilities: ModelCapabilities): Promise<ModelStepInput> {
    const conversation = await requireConversation(this.store, conversationId);
    const pluginFragments = await this.plugins.collectContextFragments({ conversation, effectiveProfile: conversation.effectiveProfile });
    const projectionBlock = (await this.store.listContextBlocks(conversationId, { kind: "projection" })).at(-1);
    const coveredThroughMessageSequence = projectionBlock ? projectionMessageCursor(projectionBlock) : undefined;
    const messages = (await this.store.listMessages(conversationId, { limit: 50 }))
      .filter((message) => coveredThroughMessageSequence === undefined || message.sequence > coveredThroughMessageSequence);
    const stateRecords = await this.store.listStateNamespaces(conversationId);
    const unresolvedInteractions = await this.store.listPendingInteractions(conversationId);
    const executionContext = await this.contexts.getActiveContext(conversationId);

    const selectedBlocks: Array<{ block: ContextBlock; role?: MessageRole; tokenEstimate?: number }> = [];
    const systemFragments: ContentBlock[] = [];
    for (const text of conversation.effectiveProfile.config.promptFragments) {
      systemFragments.push({ type: "text", text });
    }
    systemFragments.push(...pluginFragments);
    if (projectionBlock) {
      selectedBlocks.push({ block: projectionBlock, role: "system" });
      systemFragments.push(...projectionBlock.content);
    }
    for (const state of stateRecords) {
      const block = await this.store.createContextBlock({
        conversationId,
        turnId,
        kind: "state",
        content: [{ type: "data", label: state.namespace, data: state.value }],
        data: state.value,
        metadata: { namespace: state.namespace, version: state.version }
      });
      selectedBlocks.push({ block, role: "system" });
      systemFragments.push({ type: "data", label: state.namespace, data: state.value });
    }
    if (executionContext) {
      const block = await this.store.createContextBlock({
        conversationId,
        turnId,
        kind: "execution_context",
        content: [{ type: "data", label: "execution_context", data: executionContext as unknown as JsonValue }],
        data: executionContext as unknown as JsonValue,
        metadata: { providerKind: executionContext.providerKind }
      });
      selectedBlocks.push({ block, role: "system" });
    }
    for (const interaction of unresolvedInteractions) {
      const block = await this.store.createContextBlock({
        conversationId,
        turnId: interaction.turnId,
        ...(interaction.activityId ? { activityId: interaction.activityId } : {}),
        kind: "interaction_result",
        content: [
          { type: "interaction_ref", interactionId: interaction.id, label: interaction.kind },
          ...interaction.prompt
        ],
        data: { interactionId: interaction.id, status: interaction.status, kind: interaction.kind }
      });
      selectedBlocks.push({ block, role: "system" });
      systemFragments.push({ type: "interaction_ref", interactionId: interaction.id, label: interaction.kind });
    }

    const contextMessages: ModelContextMessage[] = [];
    if (systemFragments.length > 0) {
      const block = await this.store.createContextBlock({
        conversationId,
        turnId,
        kind: "profile_fragment",
        content: systemFragments
      });
      selectedBlocks.push({ block, role: "system", tokenEstimate: estimateTokens(systemFragments) });
      contextMessages.push({ role: "system", content: systemFragments, metadata: {} });
    }

    const unsupportedInputBlocks: ContentBlock[] = [];
    const existingBlocks = await this.store.listContextBlocks(conversationId);
    for (const message of messages) {
      const unsupportedForMessage = message.content.filter((block) => !isBlockSupportedByModel(block, capabilities));
      unsupportedInputBlocks.push(...unsupportedForMessage);
      const metadata: Record<string, JsonValue> = {
        messageId: message.id,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        ...(unsupportedForMessage.length > 0 ? { unsupportedBlockCount: unsupportedForMessage.length } : {})
      };
      contextMessages.push({
        role: message.role,
        content: message.content,
        metadata
      });
      const messageBlock =
        existingBlocks.find((block) => block.kind === "message" && block.metadata.messageId === message.id) ??
        await this.store.createContextBlock({
          conversationId,
          ...(message.turnId ? { turnId: message.turnId } : {}),
          ...(message.source?.type === "activity" ? { activityId: message.source.id } : {}),
          kind: "message",
          content: message.content,
          data: { messageId: message.id, role: message.role },
          metadata: { messageId: message.id, role: message.role }
        });
      selectedBlocks.push({ block: messageBlock, role: message.role, tokenEstimate: estimateTokens(message.content) });
    }

    const selectedBlockIds = new Set(selectedBlocks.map((item) => item.block.id));
    const modelMetadata = (await this.store.listContextModelMetadata()).filter((metadata) => selectedBlockIds.has(metadata.blockId));
    const diagnostics: Record<string, JsonValue> = {
      selectedBlockCount: selectedBlocks.length,
      unsupportedInputBlockCount: unsupportedInputBlocks.length,
      preservedProviderMetadataCount: modelMetadata.filter((metadata) => metadata.provider === conversation.effectiveProfile.config.model.provider && metadata.modelId === conversation.effectiveProfile.config.model.modelId).length,
      adaptedProviderMetadataCount: modelMetadata.filter((metadata) => metadata.provider === conversation.effectiveProfile.config.model.provider && metadata.modelId !== conversation.effectiveProfile.config.model.modelId).length,
      droppedProviderMetadataCount: modelMetadata.filter((metadata) => metadata.provider !== conversation.effectiveProfile.config.model.provider).length
    };
    const contextBuild = await this.store.createContextBuild({
      conversationId,
      turnId,
      modelConfig: conversation.effectiveProfile.config.model,
      policyId: DEFAULT_CONTEXT_POLICY_ID,
      diagnostics
    });
    for (const [sequence, item] of selectedBlocks.entries()) {
      await this.store.addContextBuildItem({
        contextBuildId: contextBuild.id,
        blockId: item.block.id,
        sequence,
        ...(item.role ? { role: item.role } : {}),
        ...(item.tokenEstimate === undefined ? {} : { tokenEstimate: item.tokenEstimate })
      });
      await this.store.createContextModelMetadata({
        blockId: item.block.id,
        provider: conversation.effectiveProfile.config.model.provider,
        modelId: conversation.effectiveProfile.config.model.modelId,
        metadata: { contextBuildId: contextBuild.id }
      });
    }

    const availableTools = this.tools.list(conversation.effectiveProfile.config.enabledTools)
      .filter((tool) => tool.visibility !== "ui")
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        visibility: tool.visibility ?? "model" as const,
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema })
      }));
    const modelInput = {
      conversationId,
      turnId,
      contextBuildId: contextBuild.id,
      effectiveProfile: conversation.effectiveProfile,
      modelConfig: conversation.effectiveProfile.config.model,
      ...(conversation.providerResumeState === undefined ? {} : { providerResumeState: conversation.providerResumeState }),
      messages: contextMessages,
      availableTools,
      unsupportedInputBlocks
    };
    return executionContext ? { ...modelInput, executionContext } : modelInput;
  }
}

function isBlockSupportedByModel(block: ContentBlock, capabilities: ModelCapabilities): boolean {
  switch (block.type) {
    case "text":
      return capabilities.textInput;
    case "image_ref":
      return capabilities.imageInput;
    case "file_ref":
      return capabilities.fileInput;
    case "pdf_ref":
      return capabilities.pdfInput;
    case "audio_ref":
      return capabilities.audioInput;
    default:
      return true;
  }
}

function estimateTokens(blocks: ContentBlock[]): number {
  const text = blocks.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
  return Math.ceil(text.length / 4);
}

function projectionMessageCursor(block: ContextBlock): number | undefined {
  const metadataValue = block.metadata.coveredThroughMessageSequence;
  if (typeof metadataValue === "number") {
    return metadataValue;
  }
  if (isRecord(block.data) && typeof block.data.coveredThroughMessageSequence === "number") {
    return block.data.coveredThroughMessageSequence;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
