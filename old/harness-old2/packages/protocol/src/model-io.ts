import { z } from "zod";
import { modelAccountingSchema } from "./accounting.ts";
import { contentBlockSchema } from "./content.ts";
import { idSchema } from "./ids.ts";
import { messageRoleSchema } from "./conversation.ts";
import { modelConfigSchema } from "./model-config.ts";
import {
    providerPayloadDraftSchema,
    providerPayloadSchema,
    providerResponseSchema,
} from "./provider-payload.ts";

export const modelContextItemSchema = z.object({
    itemId: idSchema,
    conversationId: idSchema,
    sequence: z.number().int().positive(),
    role: messageRoleSchema,
    content: z.array(contentBlockSchema),
    providerPayload: providerPayloadSchema.optional(),
});
export type ModelContextItem = z.infer<typeof modelContextItemSchema>;

export const modelRequestSchema = z.object({
    conversationId: idSchema,
    runId: idSchema,
    contextBuildId: idSchema.optional(),
    modelConfig: modelConfigSchema,
    instructions: z.array(contentBlockSchema).default([]),
    items: z.array(modelContextItemSchema),
});
export type ModelRequest = z.infer<typeof modelRequestSchema>;

export const modelFinalResponseSchema = z.object({
    assistant: z.object({
        content: z.array(contentBlockSchema),
        providerPayload: providerPayloadDraftSchema.optional(),
    }),
    providerResponse: providerResponseSchema.optional(),
    accounting: modelAccountingSchema.optional(),
});
export type ModelFinalResponse = z.infer<typeof modelFinalResponseSchema>;

export const modelStreamEventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("text_delta"),
        delta: z.string(),
    }),
    z.object({
        type: z.literal("completed"),
        response: modelFinalResponseSchema,
    }),
]);
export type ModelStreamEvent = z.infer<typeof modelStreamEventSchema>;
