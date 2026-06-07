import { z } from "zod";

/**
 * The on-disk settings document — kernel keys plus an opaque per-plugin namespace
 * and named profiles. Strict: an unknown top-level key (a typo) is rejected. Plugin
 * slices are opaque here and validated later against each plugin's own schema.
 */
const modelSchema = z.strictObject({ provider: z.string(), model: z.string() });
const toolsSchema = z.strictObject({ allow: z.array(z.string()).optional() });

const baseFields = {
  model: modelSchema.optional(),
  instructions: z.string().optional(),
  tools: toolsSchema.optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
};

/** A profile is a settings fragment without nested profiles. */
export const profileDocSchema = z.strictObject(baseFields);

export const settingsDocSchema = z.strictObject({
  ...baseFields,
  profiles: z.record(z.string(), profileDocSchema).optional(),
});

export type SettingsDoc = z.infer<typeof settingsDocSchema>;

/** First validation issue as `path: message`, for human-readable config errors. */
export function formatIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
