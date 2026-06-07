import { z } from "zod";
import { contentBlockSchema } from "./content.ts";
import { idSchema } from "./ids.ts";
import { modelSettingsSchema, profileConfigSchema } from "./model-config.ts";

export const messageRoleSchema = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const conversationStatusSchema = z.enum([
    "created",
    "running",
    "idle",
    "failed",
    "cancelled",
]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationRecordSchema = z.object({
    id: idSchema,
    profileName: z.string().optional(),
    config: profileConfigSchema,
    title: z.string().optional(),
    status: conversationStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const conversationInputDeliverySchema = z.enum([
    "send",
    "queue",
    "interrupt",
]);
export type ConversationInputDelivery = z.infer<
    typeof conversationInputDeliverySchema
>;

export const conversationItemTypeSchema = z.enum([
    "message",
    "model_change",
    "compaction",
    "model_error",
]);
export type ConversationItemType = z.infer<typeof conversationItemTypeSchema>;

export const conversationMessageStatusSchema = z.enum([
    "complete",
    "interrupted",
]);
export type ConversationMessageStatus = z.infer<
    typeof conversationMessageStatusSchema
>;

const conversationItemBaseSchema = z.object({
    id: idSchema,
    conversationId: idSchema,
    sequence: z.number().int().positive(),
    createdAt: z.string(),
});

const conversationItemInputBaseSchema = z.object({
    id: idSchema.optional(),
    conversationId: idSchema,
});

export const conversationMessageItemSchema =
    conversationItemBaseSchema.extend({
        type: z.literal("message"),
        role: messageRoleSchema,
        status: conversationMessageStatusSchema,
        content: z.array(contentBlockSchema),
        runId: idSchema.optional(),
        sourceItemId: idSchema.optional(),
    });
export type ConversationMessageItem = z.infer<
    typeof conversationMessageItemSchema
>;

export const conversationMessageItemInputSchema =
    conversationItemInputBaseSchema.extend({
        type: z.literal("message"),
        role: messageRoleSchema,
        status: conversationMessageStatusSchema.default("complete"),
        content: z.array(contentBlockSchema),
        runId: idSchema.optional(),
        sourceItemId: idSchema.optional(),
    });

export const modelChangeItemSchema = conversationItemBaseSchema.extend({
    type: z.literal("model_change"),
    provider: z.string(),
    modelId: z.string(),
    settings: modelSettingsSchema.optional(),
});
export type ModelChangeItem = z.infer<typeof modelChangeItemSchema>;

export const modelChangeItemInputSchema =
    conversationItemInputBaseSchema.extend({
        type: z.literal("model_change"),
        provider: z.string(),
        modelId: z.string(),
        settings: modelSettingsSchema.optional(),
    });

export const compactionItemSchema = conversationItemBaseSchema.extend({
    type: z.literal("compaction"),
    summary: z.array(contentBlockSchema),
    coversThroughItemSequence: z.number().int().nonnegative(),
    firstKeptItemId: idSchema.optional(),
    policyId: z.string(),
    tokenEstimate: z.number().int().nonnegative(),
});
export type CompactionItem = z.infer<typeof compactionItemSchema>;

export const compactionItemInputSchema = conversationItemInputBaseSchema.extend(
    {
        type: z.literal("compaction"),
        summary: z.array(contentBlockSchema),
        coversThroughItemSequence: z.number().int().nonnegative(),
        firstKeptItemId: idSchema.optional(),
        policyId: z.string(),
        tokenEstimate: z.number().int().nonnegative(),
    },
);

export const modelErrorItemSchema = conversationItemBaseSchema.extend({
    type: z.literal("model_error"),
    runId: idSchema,
    message: z.string(),
    error: z.json().optional(),
});
export type ModelErrorItem = z.infer<typeof modelErrorItemSchema>;

export const modelErrorItemInputSchema =
    conversationItemInputBaseSchema.extend({
        type: z.literal("model_error"),
        runId: idSchema,
        message: z.string(),
        error: z.json().optional(),
    });

export const conversationItemSchema = z.discriminatedUnion("type", [
    conversationMessageItemSchema,
    modelChangeItemSchema,
    compactionItemSchema,
    modelErrorItemSchema,
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationItemInputSchema = z.discriminatedUnion("type", [
    conversationMessageItemInputSchema,
    modelChangeItemInputSchema,
    compactionItemInputSchema,
    modelErrorItemInputSchema,
]);
export type ConversationItemInput = z.input<typeof conversationItemInputSchema>;

export const pendingConversationInputSchema = z.object({
    id: idSchema,
    conversationId: idSchema,
    requestedDelivery: z.enum(["send", "queue"]),
    afterRunId: idSchema,
    content: z.array(contentBlockSchema),
    createdAt: z.string(),
});
export type PendingConversationInput = z.infer<
    typeof pendingConversationInputSchema
>;
