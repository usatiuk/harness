import { z } from "zod";
import { modelMetadataSchema } from "@harness/protocol";
import { MAX_MODELS } from "./catalog.ts";

export const configuredModelSchema = modelMetadataSchema
  .extend({
    temperature: z.number().min(0).max(2).optional(),
  })
  .refine(
    (model) => !model.customToolInput?.supported,
    "This adapter supports JSON tool input only",
  )
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
