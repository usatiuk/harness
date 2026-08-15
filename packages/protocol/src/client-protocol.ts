import { z } from "zod";
import { defineNotification, defineRequest, jsonValueSchema } from "./rpc.ts";

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

export const wireItemSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("message"),
    role: z.enum(["user", "assistant", "system"]),
    content: z.array(wireContentBlockSchema),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("reasoning"),
    content: z.array(wireContentBlockSchema),
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    args: jsonValueSchema,
  }),
  z.strictObject({
    ...itemBaseShape,
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.array(wireContentBlockSchema),
    status: z.enum(["ok", "error"]),
    annotations: z.record(z.string(), jsonValueSchema).nullable(),
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

export const wireConversationConfigSchema = z.strictObject({
  instructions: z.string(),
  model: wireModelConfigSchema,
  tools: z.strictObject({ allow: z.array(z.string()).nullable() }).nullable(),
  plugins: z.record(z.string(), jsonValueSchema),
});
export type WireConversationConfig = z.infer<typeof wireConversationConfigSchema>;

export const wireConversationSchema = z.strictObject({
  id: idSchema,
  workspaceRoot: z.string().nullable(),
  overrides: z.record(z.string(), jsonValueSchema),
  head: idSchema.nullable(),
  createdAt: z.number().int(),
  config: wireConversationConfigSchema,
});
export type WireConversation = z.infer<typeof wireConversationSchema>;

export const wireModelInfoSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  label: z.string().nullable(),
  presets: z.array(z.strictObject({ value: z.string(), label: z.string().nullable() })),
  defaultPreset: z.string().nullable(),
  contextWindow: positiveInteger.nullable(),
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
  lastInputTokens: nonnegativeInteger.nullable(),
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

const conversationCursorSchema = z.strictObject({
  createdAt: z.number().int(),
  id: idSchema,
});

export const conversationListRequest = defineRequest({
  direction: "client-to-server",
  method: "conversation.list",
  params: z.strictObject({
    cursor: conversationCursorSchema.nullable(),
    limit: positiveInteger.max(MAX_CONVERSATION_PAGE_SIZE),
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
  z.strictObject({ type: z.literal("text.delta"), turnId: idSchema, text: z.string() }),
  z.strictObject({ type: z.literal("reasoning.delta"), turnId: idSchema, text: z.string() }),
  z.strictObject({ type: z.literal("head.changed"), head: idSchema.nullable() }),
  z.strictObject({ type: z.literal("config.changed"), config: wireConversationConfigSchema }),
  z.strictObject({
    type: z.literal("usage.changed"),
    summary: wireUsageSummarySchema,
  }),
]);
export type WireConversationEvent = z.infer<typeof wireConversationEventSchema>;

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
  conversationPresetSetRequest,
  conversationPluginConfigPatchRequest,
  conversationEventNotification,
] as const;
