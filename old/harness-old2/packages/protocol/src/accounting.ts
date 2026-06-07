import { z } from "zod";

export const tokenUsageSchema = z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const costEstimateSchema = z.object({
    amountMicros: z.number().int().nonnegative(),
    currency: z.literal("USD"),
    pricingVersion: z.string(),
    estimated: z.boolean(),
});
export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const modelAccountingSchema = z.object({
    usage: tokenUsageSchema.optional(),
    cost: costEstimateSchema.optional(),
});
export type ModelAccounting = z.infer<typeof modelAccountingSchema>;
