import { z } from "zod";

export const SOURCE_FIRST_MARKER = "harness:protocol:src";

export type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const idSchema = z.string().min(1);
export type EntityId = z.infer<typeof idSchema>;

export const textContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

export const structuredDataContentBlockSchema = z.object({
  type: z.literal("data"),
  label: z.string().optional(),
  data: jsonValueSchema
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textContentBlockSchema,
  structuredDataContentBlockSchema
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const messageRoleSchema = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const modelSettingsSchema = z.object({
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional()
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelConfigSchema = z.object({
  provider: z.string().default("fake"),
  adapter: z.string().default("fake"),
  modelId: z.string().default("fake-text"),
  settings: modelSettingsSchema.optional(),
  providerOptions: jsonValueSchema.optional()
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const profileConfigSchema = z.object({
  model: modelConfigSchema.default({ provider: "fake", adapter: "fake", modelId: "fake-text" }),
  promptFragments: z.array(z.string()).default([])
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

export const conversationStatusSchema = z.enum(["created", "running", "idle", "failed", "cancelled"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationRecordSchema = z.object({
  id: idSchema,
  profileName: z.string().optional(),
  config: profileConfigSchema,
  title: z.string().optional(),
  status: conversationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const conversationItemClassSchema = z.enum(["transcript", "control", "provider", "projection", "audit"]);
export type ConversationItemClass = z.infer<typeof conversationItemClassSchema>;

export const conversationItemKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "system_message",
  "model_error",
  "provider_event",
  "context_projection",
  "run_event",
  "audit_note"
]);
export type ConversationItemKind = z.infer<typeof conversationItemKindSchema>;

export const conversationItemVisibilitySchema = z.enum(["model", "ui", "audit"]);
export type ConversationItemVisibility = z.infer<typeof conversationItemVisibilitySchema>;

export const conversationInputDeliverySchema = z.enum(["send", "queue", "manual", "interrupt"]);
export type ConversationInputDelivery = z.infer<typeof conversationInputDeliverySchema>;

export const sourceRefSchema = z.object({
  type: z.string(),
  id: idSchema.optional()
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const conversationItemSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  sequence: z.number().int().positive(),
  class: conversationItemClassSchema,
  kind: conversationItemKindSchema,
  role: messageRoleSchema.optional(),
  visibility: conversationItemVisibilitySchema,
  runId: idSchema.optional(),
  source: sourceRefSchema.optional(),
  content: z.array(contentBlockSchema),
  data: jsonValueSchema.optional(),
  createdAt: z.string()
});
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const agentRunStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunRecordSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  status: agentRunStatusSchema,
  startedThroughItemSequence: z.number().int().nonnegative(),
  completedThroughItemSequence: z.number().int().nonnegative().optional(),
  modelConfig: modelConfigSchema,
  providerStateId: idSchema.optional(),
  error: jsonValueSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;

export const providerEventPayloadSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.string(),
  normalized: jsonValueSchema,
  providerRequestId: z.string().optional(),
  providerResponseId: z.string().optional(),
  providerItemId: z.string().optional(),
  providerOperationId: z.string().optional()
});
export type ProviderEventPayload = z.infer<typeof providerEventPayloadSchema>;

export const providerStateSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  provider: z.string(),
  adapter: z.string(),
  modelId: z.string(),
  payloadVersion: z.number().int().positive(),
  payload: jsonValueSchema,
  producedThroughItemSequence: z.number().int().nonnegative(),
  referencedItemSequences: z.array(z.number().int().positive()),
  createdAt: z.string()
});
export type ProviderState = z.infer<typeof providerStateSchema>;

export const contextProjectionSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  itemId: idSchema,
  coversThroughItemSequence: z.number().int().nonnegative(),
  policyId: z.string(),
  content: z.array(contentBlockSchema),
  tokenEstimate: z.number().int().nonnegative(),
  diagnostics: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ContextProjection = z.infer<typeof contextProjectionSchema>;

export const contextBuildSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  runId: idSchema,
  modelConfig: modelConfigSchema,
  projectionId: idSchema.optional(),
  selectedItemIds: z.array(idSchema),
  selectedItemSequences: z.array(z.number().int().positive()),
  diagnostics: z.record(z.string(), jsonValueSchema).default({}),
  createdAt: z.string()
});
export type ContextBuild = z.infer<typeof contextBuildSchema>;

export const modelContextMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  metadata: z.record(z.string(), jsonValueSchema).default({})
});
export type ModelContextMessage = z.infer<typeof modelContextMessageSchema>;

export const modelCapabilitiesSchema = z.object({
  textInput: z.boolean(),
  textOutput: z.boolean(),
  reasoningMetadata: z.boolean()
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const modelStepInputSchema = z.object({
  conversationId: idSchema,
  runId: idSchema,
  contextBuildId: idSchema.optional(),
  modelConfig: modelConfigSchema,
  messages: z.array(modelContextMessageSchema),
  providerState: providerStateSchema.optional()
});
export type ModelStepInput = z.infer<typeof modelStepInputSchema>;

export const modelStepResultSchema = z.object({
  content: z.array(contentBlockSchema),
  providerEvents: z.array(providerEventPayloadSchema).default([]),
  providerState: z.object({
    payloadVersion: z.number().int().positive(),
    payload: jsonValueSchema,
    referencedItemSequences: z.array(z.number().int().positive()).default([])
  }).optional(),
  usage: jsonValueSchema.optional(),
  cost: jsonValueSchema.optional(),
  metadata: z.record(z.string(), z.string()).default({})
});
export type ModelStepResult = z.input<typeof modelStepResultSchema>;
export type ParsedModelStepResult = z.output<typeof modelStepResultSchema>;
