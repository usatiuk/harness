import { z } from "zod";
import type { ProviderSetting } from "./client-protocol.ts";

/** Project explicitly exposed fields, never the full config or credential schema. */
export function providerSettings(
  schema: z.ZodType,
  config: Record<string, unknown>,
): ProviderSetting[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const fields = schema.shape as Record<string, z.ZodType>;
  const settings: ProviderSetting[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const metadata = field.meta();
    if (metadata?.harnessSetting !== true) continue;
    if (typeof metadata.title !== "string" || !metadata.title)
      throw new Error(`Exposed provider setting '${key}' requires a title`);
    if (z.toJSONSchema(field, { io: "input" }).type !== "boolean")
      throw new Error(`Exposed provider setting '${key}' must be a boolean`);
    const value: unknown = field.parse(config[key]);
    if (typeof value !== "boolean")
      throw new Error(`Exposed provider setting '${key}' requires a boolean value or default`);
    settings.push({
      key,
      title: metadata.title,
      description: metadata.description ?? null,
      value,
    });
  }
  return settings;
}
