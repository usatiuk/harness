import { z } from "zod";
import { modelMetadataSchema } from "@harness/protocol";

const presetControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("effort"), effort: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("thinking"), thinking: z.enum(["disabled", "adaptive"]) }),
  z.strictObject({ kind: z.literal("thinking-budget"), budgetTokens: z.number().int().min(1024) }),
]);
export const configuredModelSchema = modelMetadataSchema.extend({
  transport: z.enum(["chat", "responses", "messages"]).optional(),
  presets: z
    .array(
      z.strictObject({
        value: z.string().min(1).max(64),
        label: z.string().min(1).max(200).optional(),
        control: presetControlSchema,
      }),
    )
    .max(64)
    .refine(
      (presets) => new Set(presets.map((preset) => preset.value)).size === presets.length,
      "Preset values must be unique",
    )
    .optional(),
  defaultPreset: z.string().min(1).max(64).optional(),
});
export type ConfiguredModel = z.infer<typeof configuredModelSchema>;
