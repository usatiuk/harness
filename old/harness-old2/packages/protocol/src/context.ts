import { z } from "zod";
import { idSchema } from "./ids.ts";
import { modelConfigSchema } from "./model-config.ts";

export const contextBuildSchema = z.object({
    id: idSchema,
    conversationId: idSchema,
    runId: idSchema,
    modelConfig: modelConfigSchema,
    compactionItemId: idSchema.optional(),
    selectedItemIds: z.array(idSchema),
    selectedItemSequences: z.array(z.number().int().positive()),
    diagnostics: z.record(z.string(), z.json()).default({}),
    createdAt: z.string(),
});
export type ContextBuild = z.infer<typeof contextBuildSchema>;
