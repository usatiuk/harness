import { z } from "zod";
import { idSchema } from "./ids.ts";

export const providerResponseSchema = z.object({
    provider: z.string(),
    modelId: z.string(),
    requestId: z.string().optional(),
    responseId: z.string().optional(),
});
export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export const providerPayloadSchema = z.object({
    id: idSchema,
    conversationId: idSchema,
    itemId: idSchema,
    itemSequence: z.number().int().positive(),
    provider: z.string(),
    modelId: z.string(),
    type: z.string(),
    version: z.number().int().positive(),
    payload: z.json(),
    createdAt: z.string(),
});
export type ProviderPayload = z.infer<typeof providerPayloadSchema>;

export const providerPayloadDraftSchema = z.object({
    type: z.string(),
    version: z.number().int().positive(),
    payload: z.json(),
});
export type ProviderPayloadDraft = z.infer<
    typeof providerPayloadDraftSchema
>;
