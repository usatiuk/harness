import { z } from "zod";
import { modelAccountingSchema } from "./accounting.ts";
import { idSchema } from "./ids.ts";
import { modelConfigSchema } from "./model-config.ts";
import { providerResponseSchema } from "./provider-payload.ts";

export const agentRunStatusSchema = z.enum([
    "running",
    "completed",
    "failed",
    "cancelled",
]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunRecordSchema = z.object({
    id: idSchema,
    conversationId: idSchema,
    status: agentRunStatusSchema,
    startedThroughItemSequence: z.number().int().nonnegative(),
    completedThroughItemSequence: z.number().int().nonnegative().optional(),
    modelConfig: modelConfigSchema,
    outputItemId: idSchema.optional(),
    providerResponse: providerResponseSchema.optional(),
    accounting: modelAccountingSchema.optional(),
    error: z.json().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;
