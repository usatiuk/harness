import { z } from "zod";

/** Required settings on the client boundary; configuration adds defaults separately. */
export const modelRetriesSettingsSchema = z.strictObject({
  attempts: z.number().int().min(0).max(10),
  backoffMs: z.number().int().min(50).max(60_000),
});
