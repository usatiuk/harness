import { z } from "zod";
import { MAX_MODELS } from "./catalog.ts";

export const configuredModelSchema = z
  .strictObject({
    supportsImages: z.boolean().optional(),
    label: z.string().trim().min(1).max(512).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .refine(
    (model) =>
      model.contextWindow === undefined ||
      model.maxOutputTokens === undefined ||
      model.maxOutputTokens <= model.contextWindow,
    { message: "maxOutputTokens cannot exceed contextWindow", path: ["maxOutputTokens"] },
  );

export const configuredModelsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(512)
      .refine((id) => id.trim().length > 0, "Model ID must not be blank"),
    configuredModelSchema,
  )
  .refine(
    (models) => Object.keys(models).length <= MAX_MODELS,
    "Mistral config exceeds 5000 models",
  );

export type ConfiguredModel = z.infer<typeof configuredModelSchema>;
