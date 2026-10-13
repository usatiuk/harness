import { z } from "zod";
import { outputRefSchema } from "./tools.ts";
import { defineNotification, defineRequest, jsonValueSchema } from "./rpc.ts";
import { modelReasoningInfoSchema } from "./model.ts";

const idSchema = z.string().min(1);
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

export const MAX_RPC_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_RPC_WRITER_QUEUE_BYTES = MAX_RPC_FRAME_BYTES * 2;
export const MAX_ATTACH_BYTES = 2 * 1024 * 1024;
export const DEFAULT_HISTORY_PAGE_BYTES = 512 * 1024;
export const MAX_HISTORY_PAGE_BYTES = 1024 * 1024;
export const MAX_ITEM_CHUNK_BYTES = 512 * 1024;
export const MAX_CONVERSATION_PAGE_SIZE = 100;

export const wireContentBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

const itemBaseShape = {
  id: idSchema,
  conversationId: idSchema,
  turnId: idSchema,
  seq: nonnegativeInteger,
  parent: idSchema.nullable(),
  createdAt: z.number().int(),
};

const messageShape = {
  ...itemBaseShape,
  type: z.literal("message"),
  content: z.array(wireContentBlockSchema),
};

export const wireItemSchema = z.discriminatedUnion("type", [
  z.discriminatedUnion("role", [
    z.strictObject({
      ...messageShape,
      role: z.literal("assistant"),
      phase: z.strictObject({ value: z.string().nullable() }).nullable().default(null),
    }),
    z.strictObject({
      ...messageShape,
      role: z.enum(["user", "system"]),
      phase: z.null().default(null),
    }),
  ]),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("reasoning"),
    content: z.array(wireContentBlockSchema),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("provider_output"),
    content: z.array(wireContentBlockSchema),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    args: jsonValueSchema,
    parentCallId: z.string().nullable().default(null),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.array(wireContentBlockSchema),
    status: z.enum(["ok", "error"]),
    parentCallId: z.string().nullable().default(null),
    annotations: z.record(z.string(), jsonValueSchema).nullable(),
    structured: z.strictObject({ value: jsonValueSchema }).nullable().default(null),
    structuredRef: outputRefSchema.nullable().default(null),
    full: outputRefSchema.nullable().default(null),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("compaction"),
    content: z.array(wireContentBlockSchema),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("context"),
    content: z.array(wireContentBlockSchema),
    key: z.string(),
  }),
]);
export type WireItem = z.infer<typeof wireItemSchema>;

export const wireModelConfigSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  preset: z.string().nullable(),
});

export const compactionThresholdSchema = z.number().int().positive();
export const wireConversationConfigSchema = z.strictObject({
  instructions: z.string(),
  model: wireModelConfigSchema,
  tools: z
    .strictObject({
      allow: z.array(z.string()).nullable(),
      mode: z.enum(["direct", "hybrid", "code-only"]).default("direct"),
    })
    .nullable(),
  plugins: z.record(z.string(), jsonValueSchema),
  compaction: z
    .strictObject({ thresholdTokens: compactionThresholdSchema })
    .nullable()
    .default(null),
});
export type WireConversationConfig = z.infer<typeof wireConversationConfigSchema>;

export const wireConversationSchema = z.strictObject({
  id: idSchema,
  workspaceRoot: z.string().nullable(),
  title: z.string().nullable(),
  overrides: z.record(z.string(), jsonValueSchema),
  head: idSchema.nullable(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int(),
  config: wireConversationConfigSchema,
});
export type WireConversation = z.infer<typeof wireConversationSchema>;

const rateCardShape = {
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedRead: z.number().nonnegative().nullable(),
  cacheWrite: z.record(z.string().regex(/^[1-9][0-9]*$/), z.number().nonnegative()).nullable(),
};
export const wireModelInfoSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  label: z.string().nullable(),
  presets: z.array(z.strictObject({ value: z.string(), label: z.string().nullable() })),
  defaultPreset: z.string().nullable(),
  contextWindow: positiveInteger.nullable(),
  maxInputTokens: positiveInteger.nullable(),
  maxOutputTokens: positiveInteger.nullable(),
  reasoning: z
    .strictObject({
      supported: modelReasoningInfoSchema.shape.supported.unwrap().nullable(),
      adaptiveThinking: modelReasoningInfoSchema.shape.adaptiveThinking.unwrap().nullable(),
      legacyThinking: modelReasoningInfoSchema.shape.legacyThinking.unwrap().nullable(),
      alwaysOn: modelReasoningInfoSchema.shape.alwaysOn.unwrap().nullable(),
      effortLevels: modelReasoningInfoSchema.shape.effortLevels.unwrap().nullable(),
      defaultEffort: modelReasoningInfoSchema.shape.defaultEffort.unwrap().nullable(),
    })
    .nullable(),
  pricing: z
    .strictObject({
      ...rateCardShape,
      longContext: z.strictObject({ ...rateCardShape, threshold: positiveInteger }).nullable(),
    })
    .nullable(),
});
export type WireModelInfo = z.infer<typeof wireModelInfoSchema>;

export const wireUsageSchema = z.strictObject({
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  cachedReadTokens: nonnegativeInteger,
  cacheWriteTokens: z.record(z.string(), nonnegativeInteger).nullable(),
});

export const wireUsageSummarySchema = z.strictObject({
  usage: wireUsageSchema,
  incomplete: z.boolean(),
  cost: z.number().nonnegative(),
  costIncomplete: z.boolean().default(false),
  lastInputTokens: nonnegativeInteger.nullable(),
  agentContext: z
    .strictObject({
      provider: z.string().min(1),
      model: z.string().min(1),
      turnId: idSchema,
      usage: wireUsageSchema.nullable(),
      createdAt: nonnegativeInteger,
    })
    .nullable(),
  lastTurn: z
    .strictObject({
      turnId: idSchema,
      status: z.enum(["completed", "failed", "aborted"]),
      usage: wireUsageSchema,
      incomplete: z.boolean(),
      cost: z.number().nonnegative(),
      costIncomplete: z.boolean().default(false),
      agentOutputTokens: nonnegativeInteger.nullable(),
      agentDurationMs: z.number().nonnegative().nullable(),
    })
    .nullable(),
});
export type WireUsageSummary = z.infer<typeof wireUsageSummarySchema>;

export const wireLiveStateSchema = z.strictObject({
  conversationId: idSchema,
  status: z.enum(["idle", "running"]),
  turnId: idSchema.nullable(),
  pendingInput: z.array(z.strictObject({ intent: z.enum(["queue", "steer"]), text: z.string() })),
});
export type WireLiveState = z.infer<typeof wireLiveStateSchema>;

export const attachResultSchema = z.strictObject({
  root: wireConversationSchema,
  members: z.array(
    z.strictObject({
      conversation: wireConversationSchema,
      live: wireLiveStateSchema,
    }),
  ),
  usage: wireUsageSummarySchema,
  plugins: z.record(z.string(), jsonValueSchema),
});
export type AttachResult = z.infer<typeof attachResultSchema>;

export const serverModelsRequest = defineRequest({
  direction: "client-to-server",
  method: "server.models",
  params: z.strictObject({}),
  result: z.strictObject({
    models: z.array(wireModelInfoSchema),
    defaultModel: wireModelConfigSchema,
  }),
});

export const conversationCreateRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.create",
  params: z.strictObject({
    cwd: z.string().nullable(),
    overrides: z.record(z.string(), jsonValueSchema),
  }),
  result: wireConversationSchema,
});

export const conversationGetRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.get",
  params: z.strictObject({ conversationId: idSchema }),
  result: wireConversationSchema.nullable(),
});

const conversationCursorSchema = z.union([
  z.strictObject({ createdAt: z.number().int(), id: idSchema }),
  z.strictObject({ lastUsedAt: z.number().int(), id: idSchema }),
]);

export const conversationListRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.list",
  params: z.strictObject({
    cursor: conversationCursorSchema.nullable(),
    limit: positiveInteger.max(MAX_CONVERSATION_PAGE_SIZE),
    order: z.enum(["created", "lastUsed"]).default("created"),
    filter: z.strictObject({ workspaceRoot: z.string().nullable() }).nullable().default(null),
  }),
  result: z.strictObject({
    conversations: z.array(wireConversationSchema),
    nextCursor: conversationCursorSchema.nullable(),
  }),
});

export const conversationAttachRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.attach",
  params: z.strictObject({ conversationId: idSchema }),
  result: attachResultSchema,
});

export const conversationCloseRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.close",
  params: z.strictObject({ conversationId: idSchema, force: z.boolean() }),
  result: z.strictObject({ status: z.enum(["busy", "closed"]) }),
});

export const conversationReloadRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.reload",
  params: z.strictObject({ conversationId: idSchema, force: z.boolean() }),
  result: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("busy") }),
    z.strictObject({ status: z.literal("reloaded"), attachment: attachResultSchema }),
  ]),
});

export const conversationDeleteEmptyRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.deleteEmpty",
  params: z.strictObject({ conversationId: idSchema }),
  result: z.null(),
});

export const conversationDeliverRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.deliver",
  params: z.strictObject({
    conversationId: idSchema,
    text: z.string(),
    intent: z.enum(["send", "steer", "queue", "interrupt"]),
  }),
  result: z.null(),
});

export const conversationRewindRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.rewind",
  params: z.strictObject({ conversationId: idSchema, itemId: idSchema }),
  result: z.null(),
});

export const conversationCompactRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.compact",
  params: z.strictObject({ conversationId: idSchema }),
  result: z.strictObject({ status: z.enum(["compacted", "noop"]) }),
});

const historyEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("item"), item: wireItemSchema }),
  z.strictObject({
    kind: z.literal("itemRef"),
    itemId: idSchema,
    byteLength: positiveInteger,
  }),
]);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const conversationForkBeforeRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.forkBefore",
  params: z.strictObject({ conversationId: idSchema, userMessageId: idSchema }),
  result: z.strictObject({
    conversation: wireConversationSchema,
    draft: historyEntrySchema.options[1],
  }),
});

export const conversationHistoryRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.history",
  params: z.strictObject({
    conversationId: idSchema,
    anchor: idSchema.nullable(),
    cursor: idSchema.nullable(),
    maxBytes: positiveInteger.min(1024).max(MAX_HISTORY_PAGE_BYTES),
  }),
  result: z.strictObject({
    anchor: idSchema.nullable(),
    entries: z.array(historyEntrySchema),
    nextCursor: idSchema.nullable(),
  }),
});

export const conversationItemReadRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.item.read",
  params: z.strictObject({
    conversationId: idSchema,
    itemId: idSchema,
    offset: nonnegativeInteger,
    maxBytes: positiveInteger.max(MAX_ITEM_CHUNK_BYTES),
  }),
  result: z.strictObject({
    encoding: z.literal("base64"),
    offset: nonnegativeInteger,
    data: z.string(),
    nextOffset: nonnegativeInteger.nullable(),
    eof: z.boolean(),
  }),
});

export const conversationUsageRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.usage",
  params: z.strictObject({ conversationId: idSchema }),
  result: wireUsageSummarySchema,
});

export const conversationTitleSetRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.title.set",
  params: z.strictObject({ conversationId: idSchema, title: z.string().trim().min(1).max(200) }),
  result: z.null(),
});

export const conversationModelSetRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.model.set",
  params: z.strictObject({
    conversationId: idSchema,
    provider: z.string(),
    model: z.string(),
  }),
  result: z.null(),
});

export const conversationPresetSetRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.preset.set",
  params: z.strictObject({
    conversationId: idSchema,
    expected: z.strictObject({ provider: z.string(), model: z.string() }),
    preset: z.string().nullable(),
  }),
  result: z.null(),
});

export const conversationPluginConfigPatchRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.pluginConfig.patch",
  params: z.strictObject({
    conversationId: idSchema,
    pluginId: z.string(),
    patch: z.record(z.string(), jsonValueSchema),
    saveGlobal: z.boolean(),
  }),
  result: z.null(),
});

export const wireConversationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item.appended"), item: wireItemSchema }),
  z.strictObject({
    type: z.literal("turn.changed"),
    turnId: idSchema,
    status: z.enum(["running", "completed", "failed", "aborted"]),
    error: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal("input.changed"),
    pending: z.array(z.strictObject({ intent: z.enum(["queue", "steer"]), text: z.string() })),
  }),
  z.strictObject({
    type: z.literal("text.delta"),
    turnId: idSchema,
    text: z.string(),
    phase: z.strictObject({ value: z.string().nullable() }).nullable().default(null),
  }),
  z.strictObject({ type: z.literal("reasoning.delta"), turnId: idSchema, text: z.string() }),
  z.strictObject({ type: z.literal("head.changed"), head: idSchema.nullable() }),
  z.strictObject({ type: z.literal("config.changed"), config: wireConversationConfigSchema }),
  z.strictObject({ type: z.literal("title.changed"), title: z.string() }),
  z.strictObject({
    type: z.literal("usage.changed"),
    summary: wireUsageSummarySchema,
  }),
]);
export type WireConversationEvent = z.infer<typeof wireConversationEventSchema>;

/** The old activation is gone, even if cleanup or replacement preparation failed. */
export const conversationDetachedNotification = defineNotification({
  direction: "server-to-client",
  method: "conversation.detached",
  params: z.strictObject({ rootConversationId: idSchema }),
});

export const conversationEventNotification = defineNotification({
  direction: "server-to-client",
  method: "conversation.event",
  params: z.strictObject({
    rootConversationId: idSchema,
    conversationId: idSchema,
    event: wireConversationEventSchema,
  }),
});

export const coreRpcMessages = [
  serverModelsRequest,
  conversationCreateRequest,
  conversationGetRequest,
  conversationListRequest,
  conversationAttachRequest,
  conversationCloseRequest,
  conversationReloadRequest,
  conversationDeleteEmptyRequest,
  conversationDeliverRequest,
  conversationRewindRequest,
  conversationCompactRequest,
  conversationHistoryRequest,
  conversationItemReadRequest,
  conversationUsageRequest,
  conversationModelSetRequest,
  conversationForkBeforeRequest,
  conversationTitleSetRequest,
  conversationPresetSetRequest,
  conversationPluginConfigPatchRequest,
  conversationEventNotification,
  conversationDetachedNotification,
] as const;
