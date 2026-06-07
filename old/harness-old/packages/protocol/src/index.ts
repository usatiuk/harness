import { z } from "zod";

export const SOURCE_FIRST_MARKER = "protocol:src";

export type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const idSchema = z.string().min(1);
export type EntityId = z.infer<typeof idSchema>;

export const textContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

export const imageReferenceContentBlockSchema = z.object({
  type: z.literal("image_ref"),
  assetId: idSchema,
  alt: z.string().optional()
});

export const fileReferenceContentBlockSchema = z.object({
  type: z.literal("file_ref"),
  assetId: idSchema,
  filename: z.string().optional(),
  mediaType: z.string().optional()
});

export const audioReferenceContentBlockSchema = z.object({
  type: z.literal("audio_ref"),
  assetId: idSchema,
  mediaType: z.string().optional()
});

export const pdfReferenceContentBlockSchema = z.object({
  type: z.literal("pdf_ref"),
  assetId: idSchema,
  filename: z.string().optional()
});

export const artifactReferenceContentBlockSchema = z.object({
  type: z.literal("artifact_ref"),
  artifactId: idSchema,
  label: z.string().optional()
});

export const interactionReferenceContentBlockSchema = z.object({
  type: z.literal("interaction_ref"),
  interactionId: idSchema,
  label: z.string().optional()
});

export const activityReferenceContentBlockSchema = z.object({
  type: z.literal("activity_ref"),
  activityId: idSchema,
  label: z.string().optional()
});

export const structuredDataContentBlockSchema = z.object({
  type: z.literal("data"),
  data: jsonValueSchema,
  label: z.string().optional()
});

export const toolCallReferenceContentBlockSchema = z.object({
  type: z.literal("tool_call_ref"),
  toolCallId: idSchema,
  toolName: z.string(),
  input: jsonValueSchema.optional()
});

export const toolResultReferenceContentBlockSchema = z.object({
  type: z.literal("tool_result_ref"),
  toolCallId: idSchema,
  toolExecutionId: idSchema,
  status: z.enum(["ok", "error"])
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textContentBlockSchema,
  imageReferenceContentBlockSchema,
  fileReferenceContentBlockSchema,
  audioReferenceContentBlockSchema,
  pdfReferenceContentBlockSchema,
  artifactReferenceContentBlockSchema,
  interactionReferenceContentBlockSchema,
  activityReferenceContentBlockSchema,
  structuredDataContentBlockSchema,
  toolCallReferenceContentBlockSchema,
  toolResultReferenceContentBlockSchema
]);

export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const renderNodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("markdown"), markdown: z.string() }),
  z.object({ type: z.literal("code"), code: z.string(), language: z.string().optional() }),
  z.object({ type: z.literal("diff"), diff: z.string() }),
  z.object({ type: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ type: z.literal("tree"), value: jsonValueSchema }),
  z.object({ type: z.literal("form"), fields: z.array(z.object({ name: z.string(), label: z.string(), kind: z.string() })) }),
  z.object({ type: z.literal("progress"), label: z.string(), value: z.number().optional(), total: z.number().optional() }),
  z.object({ type: z.literal("link"), label: z.string(), href: z.string() }),
  z.object({ type: z.literal("asset_preview"), assetId: idSchema, label: z.string().optional() }),
  z.object({ type: z.literal("file_ref"), assetId: idSchema, filename: z.string().optional() }),
  z.object({ type: z.literal("raw_json"), value: jsonValueSchema })
]);
export type RenderNode = z.infer<typeof renderNodeSchema>;

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const sourceRefSchema = z.object({
  type: z.enum(["context_build", "tool_execution", "activity", "system"]),
  id: idSchema.optional()
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const messageRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  sequence: z.number().int().nonnegative(),
  turnId: idSchema.optional(),
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  source: sourceRefSchema.optional(),
  createdAt: z.string()
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const modelCapabilitiesSchema = z.object({
  textInput: z.boolean(),
  textOutput: z.boolean(),
  imageInput: z.boolean(),
  fileInput: z.boolean(),
  pdfInput: z.boolean(),
  audioInput: z.boolean(),
  audioOutput: z.boolean(),
  toolCalling: z.boolean(),
  hostedTools: z.boolean(),
  reasoningMetadata: z.boolean()
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const providerNativeToolConfigSchema = z.object({
  kind: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean(),
  options: jsonValueSchema.optional(),
  toolChoice: jsonValueSchema.optional(),
  budget: jsonValueSchema.optional()
});
export type ProviderNativeToolConfig = z.infer<typeof providerNativeToolConfigSchema>;

export const modelSettingsSchema = z.object({
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional()
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelConfigSchema = z.object({
  adapter: z.string(),
  provider: z.string().default("fake"),
  modelId: z.string(),
  settings: modelSettingsSchema.optional(),
  providerOptions: jsonValueSchema.optional(),
  nativeTools: z.array(providerNativeToolConfigSchema).default([])
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const providerResumeStateSchema = z.object({
  version: z.literal(1),
  provider: z.string(),
  adapter: z.string(),
  modelId: z.string(),
  payloadVersion: z.number().int().positive(),
  payload: jsonValueSchema
}).strict();
export type ProviderResumeState = z.infer<typeof providerResumeStateSchema>;

export function createProviderResumeState(input: {
  modelConfig: Pick<ModelConfig, "provider" | "adapter" | "modelId">;
  payloadVersion: number;
  payload: JsonValue;
}): ProviderResumeState {
  return providerResumeStateSchema.parse({
    version: 1,
    provider: input.modelConfig.provider,
    adapter: input.modelConfig.adapter,
    modelId: input.modelConfig.modelId,
    payloadVersion: input.payloadVersion,
    payload: input.payload
  });
}

export function providerResumeStateMatches(modelConfig: Pick<ModelConfig, "provider" | "adapter" | "modelId">, state: ProviderResumeState | undefined): boolean {
  return state !== undefined &&
    state.provider === modelConfig.provider &&
    state.adapter === modelConfig.adapter &&
    state.modelId === modelConfig.modelId;
}

export const mcpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  enabled: z.boolean().default(true)
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const pluginProfileConfigSchema = z.object({
  enabled: z.boolean(),
  config: jsonValueSchema.optional()
});
export type PluginProfileConfig = z.infer<typeof pluginProfileConfigSchema>;

export const approvalPolicySchema = z.object({
  mode: z.enum(["never", "on-request", "always"]).default("on-request"),
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([])
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const executionDefaultsSchema = z.object({
  providerKind: z.string().default("host"),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  providerConfig: jsonValueSchema.optional()
});
export type ExecutionDefaults = z.infer<typeof executionDefaultsSchema>;

export const profileConfigSchema = z.object({
  model: modelConfigSchema.default({ adapter: "fake", provider: "fake", modelId: "fake-text", nativeTools: [] }),
  promptFragments: z.array(z.string()).default([]),
  enabledTools: z.array(z.string()).default([]),
  plugins: z.record(z.string(), pluginProfileConfigSchema).default({}),
  contextProviders: z.array(z.string()).default([]),
  approvalPolicy: approvalPolicySchema.default({ mode: "on-request", allowTools: [], denyTools: [] }),
  execution: executionDefaultsSchema.default({ providerKind: "host", env: {} }),
  ui: z.record(z.string(), jsonValueSchema).default({})
});
export type ProfileConfig = z.infer<typeof profileConfigSchema>;

export const profileRecordSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  config: profileConfigSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ProfileRecord = z.infer<typeof profileRecordSchema>;

export const effectiveProfileSchema = z.object({
  profileId: idSchema.optional(),
  profileName: z.string().optional(),
  sourceProfileIds: z.array(idSchema),
  conversationOverrides: profileConfigSchema.partial().optional(),
  config: profileConfigSchema,
  resolvedAt: z.string()
});
export type EffectiveProfile = z.infer<typeof effectiveProfileSchema>;

export const workspaceRecordSchema = z.object({
  id: idSchema,
  kind: z.string(),
  rootPath: z.string().optional(),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;

export const executionContextRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema.optional(),
  workspaceId: idSchema.optional(),
  providerKind: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  providerConfig: jsonValueSchema.optional(),
  status: z.enum(["ready", "missing", "starting", "stopped"]).default("ready"),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ExecutionContextRecord = z.infer<typeof executionContextRecordSchema>;

export const conversationStatusSchema = z.enum(["created", "running", "waiting", "completed", "cancelled", "failed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationRecordSchema = z.object({
  id: idSchema,
  parentConversationId: idSchema.optional(),
  profileId: idSchema.optional(),
  effectiveProfile: effectiveProfileSchema,
  executionContextId: idSchema.optional(),
  providerResumeState: providerResumeStateSchema.optional(),
  title: z.string().optional(),
  status: conversationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const turnStatusSchema = z.enum(["running", "waiting", "completed", "cancelled", "failed", "superseded"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

export const turnRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  parentTurnId: idSchema.optional(),
  status: turnStatusSchema,
  inputMessageIds: z.array(idSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TurnRecord = z.infer<typeof turnRecordSchema>;

export const activityStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

export const activityRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  parentActivityId: idSchema.optional(),
  ownerPluginId: z.string(),
  kind: z.string(),
  label: z.string(),
  status: activityStatusSchema,
  cancellable: z.boolean().default(true),
  activityState: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
  onCompletion: z.object({ delivery: z.enum(["asap", "after_active", "manual"]) }).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

export const assetOriginSchema = z.object({
  kind: z.string(),
  detail: z.record(z.string(), jsonValueSchema).default({})
});
export type AssetOrigin = z.infer<typeof assetOriginSchema>;

export const assetRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema.optional(),
  turnId: idSchema.optional(),
  source: sourceRefSchema.optional(),
  messageId: idSchema.optional(),
  uri: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  origin: assetOriginSchema,
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  derivedFromAssetId: idSchema.optional(),
  createdAt: z.string()
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;

export const artifactRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  source: sourceRefSchema.optional(),
  kind: z.string(),
  uri: z.string().optional(),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const stateNamespaceRecordSchema = z.object({
  conversationId: idSchema,
  namespace: z.string().min(1),
  value: jsonValueSchema,
  version: z.number().int().nonnegative(),
  updatedAt: z.string()
});
export type StateNamespaceRecord = z.infer<typeof stateNamespaceRecordSchema>;

export const interactionOriginSchema = z.enum(["tool", "approval", "mcp_elicitation", "plugin", "system"]);
export type InteractionOrigin = z.infer<typeof interactionOriginSchema>;

export const interactionKindSchema = z.enum(["user_input", "approval", "confirmation", "review", "credential_url"]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const interactionStatusSchema = z.enum(["pending", "accepted", "declined", "cancelled", "expired"]);
export type InteractionStatus = z.infer<typeof interactionStatusSchema>;

export const interactionRequestSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema,
  toolExecutionId: idSchema.optional(),
  activityId: idSchema.optional(),
  origin: interactionOriginSchema,
  kind: interactionKindSchema,
  status: interactionStatusSchema,
  prompt: z.array(contentBlockSchema),
  requestedSchema: jsonValueSchema.optional(),
  render: renderNodeSchema.optional(),
  response: jsonValueSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

export const harnessEventSchema = z.object({
  sequence: z.number().int().positive(),
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  source: sourceRefSchema.optional(),
  type: z.string(),
  payload: jsonValueSchema,
  createdAt: z.string()
});
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

export const toolCallSchema = z.object({
  id: idSchema,
  name: z.string(),
  input: jsonValueSchema
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolResultSchema = z.object({
  toolCallId: idSchema,
  status: z.enum(["ok", "error"]),
  content: z.array(contentBlockSchema),
  data: jsonValueSchema.optional(),
  assetIds: z.array(idSchema).default([]),
  artifactIds: z.array(idSchema).default([]),
  summary: z.string()
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const turnStatePhaseSchema = z.enum([
  "started",
  "before_model",
  "after_model",
  "before_tool",
  "after_tool",
  "waiting_interaction",
  "waiting_approval",
  "interrupted",
  "failed",
  "completed"
]);
export type TurnStatePhase = z.infer<typeof turnStatePhaseSchema>;

export const turnStateSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema,
  phase: turnStatePhaseSchema,
  activeToolExecutionId: idSchema.optional(),
  activeActivityId: idSchema.optional(),
  contextBuildId: idSchema.optional(),
  pendingToolCalls: z.array(toolCallSchema),
  completedToolCallIds: z.array(idSchema),
  pendingInteractionIds: z.array(idSchema),
  pendingSteeringMessageIds: z.array(idSchema),
  providerResumeState: providerResumeStateSchema.optional(),
  loopState: jsonValueSchema,
  createdAt: z.string()
});
export type TurnState = z.infer<typeof turnStateSchema>;

export const conversationInputTargetSchema = z.enum(["next_turn_state", "before_next_model_step", "after_current_activity", "after_next_tool"]);
export type ConversationInputTarget = z.infer<typeof conversationInputTargetSchema>;

export const conversationInputStatusSchema = z.enum(["pending", "consumed", "cancelled"]);
export type ConversationInputStatus = z.infer<typeof conversationInputStatusSchema>;

export const conversationInputSourceSchema = z.enum(["user", "activity", "system", "plugin"]);
export type ConversationInputSource = z.infer<typeof conversationInputSourceSchema>;

export const conversationInputRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  source: conversationInputSourceSchema,
  sourceRef: sourceRefSchema.optional(),
  delivery: z.enum(["asap", "after_active", "manual"]),
  target: conversationInputTargetSchema,
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  status: conversationInputStatusSchema,
  consumedMessageId: idSchema.optional(),
  createdAt: z.string(),
  consumedAt: z.string().optional()
});
export type ConversationInputRecord = z.infer<typeof conversationInputRecordSchema>;

export const contextBlockKindSchema = z.enum([
  "message",
  "summary",
  "projection",
  "state",
  "asset_ref",
  "artifact_ref",
  "file_read",
  "tool_result",
  "profile_fragment",
  "execution_context",
  "provider_event_summary",
  "interaction_result"
]);
export type ContextBlockKind = z.infer<typeof contextBlockKindSchema>;

export const contextBlockSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  source: sourceRefSchema.optional(),
  kind: contextBlockKindSchema,
  content: z.array(contentBlockSchema).default([]),
  data: jsonValueSchema.optional(),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  coverageCursor: z.string().optional(),
  policyId: z.string().optional(),
  sourceContextBuildId: idSchema.optional(),
  createdAt: z.string()
});
export type ContextBlock = z.infer<typeof contextBlockSchema>;

export const contextBlockSourceSchema = z.object({
  blockId: idSchema,
  sourceKind: z.string(),
  sourceId: idSchema.optional(),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ContextBlockSource = z.infer<typeof contextBlockSourceSchema>;

export const contextModelMetadataSchema = z.object({
  id: idSchema,
  blockId: idSchema,
  provider: z.string(),
  modelId: z.string(),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ContextModelMetadata = z.infer<typeof contextModelMetadataSchema>;

export const contextBuildSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema.optional(),
  modelConfig: modelConfigSchema,
  policyId: z.string(),
  diagnostics: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ContextBuild = z.infer<typeof contextBuildSchema>;

export const contextBuildItemSchema = z.object({
  contextBuildId: idSchema,
  blockId: idSchema,
  sequence: z.number().int().nonnegative(),
  role: messageRoleSchema.optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), jsonValueSchema).default({})
});
export type ContextBuildItem = z.infer<typeof contextBuildItemSchema>;

export const providerEventPayloadSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  providerRequestId: z.string().optional(),
  providerResponseId: z.string().optional(),
  providerItemId: z.string().optional(),
  providerOperationId: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  kind: z.string(),
  rawPayloadRef: z.string().optional(),
  redaction: jsonValueSchema.optional(),
  normalized: jsonValueSchema
});
export type ProviderEventPayload = z.infer<typeof providerEventPayloadSchema>;

export const modelContextMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  metadata: z.record(z.string(), jsonValueSchema).default({})
});
export type ModelContextMessage = z.infer<typeof modelContextMessageSchema>;

export const toolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  visibility: z.enum(["model", "ui", "both"]).default("model"),
  inputSchema: jsonValueSchema.optional()
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const modelStepInputSchema = z.object({
  conversationId: idSchema,
  turnId: idSchema,
  contextBuildId: idSchema.optional(),
  effectiveProfile: effectiveProfileSchema,
  modelConfig: modelConfigSchema,
  providerResumeState: providerResumeStateSchema.optional(),
  messages: z.array(modelContextMessageSchema),
  availableTools: z.array(toolDescriptorSchema),
  unsupportedInputBlocks: z.array(contentBlockSchema).default([]),
  executionContext: executionContextRecordSchema.optional()
});
export type ModelStepInput = z.infer<typeof modelStepInputSchema>;

export const modelStepResultSchema = z.object({
  content: z.array(contentBlockSchema),
  toolCalls: z.array(toolCallSchema).default([]),
  providerEvents: z.array(providerEventPayloadSchema).default([]),
  providerResumeState: providerResumeStateSchema.optional(),
  usage: jsonValueSchema.optional(),
  cost: jsonValueSchema.optional(),
  metadata: z.record(z.string(), z.string()).default({})
});
export type ModelStepResult = z.infer<typeof modelStepResultSchema>;

export const toolExecutionStatusSchema = z.enum(["running", "completed", "waiting", "failed", "cancelled"]);
export type ToolExecutionStatus = z.infer<typeof toolExecutionStatusSchema>;

export const toolExecutionRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema,
  requestMessageId: idSchema.optional(),
  contextBuildId: idSchema.optional(),
  toolCallId: idSchema,
  toolName: z.string(),
  input: jsonValueSchema,
  status: toolExecutionStatusSchema,
  pendingInteractionIds: z.array(idSchema).default([]),
  resumeState: jsonValueSchema.optional(),
  result: toolResultSchema.optional(),
  createdActivityIds: z.array(idSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
