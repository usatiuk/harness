import { z } from "zod";
import type { ProviderInstanceContext } from "@harness/protocol";
import { ApiKeyAuth } from "./api-key.ts";

export const apiKeySourceSchema = z.union([
  z.object({ env: z.string().trim().min(1), stored: z.literal(true).optional() }).strict(),
  z.object({ stored: z.literal(true) }).strict(),
]);

export function instanceApiKeyAuth(
  context: ProviderInstanceContext,
  source: z.infer<typeof apiKeySourceSchema>,
  validate?: (key: string) => string | null,
): ApiKeyAuth {
  return new ApiKeyAuth({
    id: context.id,
    label: context.label,
    store: context.secrets,
    storeKey: "api-key",
    ...("env" in source ? { envVar: source.env } : {}),
    allowStored: source.stored === true,
    ...(validate ? { validate } : {}),
  });
}
