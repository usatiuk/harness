import { z } from "zod";
import { contentBlockTypeSchema } from "./content.ts";
import { idSchema } from "./ids.ts";

export const modelSettingsSchema = z.object({
    temperature: z.number().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    topP: z.number().optional(),
    seed: z.number().int().optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelConfigSchema = z.object({
    provider: z.string().default("fake"),
    modelId: z.string().default("fake-text"),
    settings: modelSettingsSchema.optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const profileConfigSchema = z.object({
    model: modelConfigSchema.default({
        provider: "fake",
        modelId: "fake-text",
    }),
    promptFragments: z.array(z.string()).default([]),
});
export type ProfileConfig = z.infer<typeof profileConfigSchema>;

export const profileRecordSchema = z.object({
    id: idSchema,
    name: z.string().min(1),
    config: profileConfigSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type ProfileRecord = z.infer<typeof profileRecordSchema>;

export const modelCapabilitiesSchema = z.object({
    inputContent: z.array(contentBlockTypeSchema),
    outputContent: z.array(contentBlockTypeSchema),
    providerPayloads: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
