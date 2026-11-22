import { z } from "zod";
import { defineProviderType, type Plugin } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { MistralProvider } from "./provider.ts";
import type { MistralMode } from "./catalog.ts";
import { configuredModelsSchema } from "./config.ts";

function providerType(mode: MistralMode) {
  return defineProviderType({
    type: `mistral-${mode}`,
    configSchema: z.preprocess(
      (value) => {
        // Existing settings remain readable; the retired field has no effect.
        if (!value || typeof value !== "object" || !("webSearch" in value)) return value;
        const active = { ...value };
        delete active.webSearch;
        return active;
      },
      z.strictObject({
        apiKey: apiKeySourceSchema.default({ stored: true }),
        models: configuredModelsSchema.default({}),
      }),
    ),
    create(context, config) {
      const auth = instanceApiKeyAuth(context, config.apiKey);
      return {
        auth,
        async buildProvider() {
          const key = await auth.getKey();
          return key ? new MistralProvider(context.id, mode, key, fetch, config.models) : null;
        },
      };
    },
  });
}
export const mistralAPIProviderType = providerType("api");
export const mistralVibeProviderType = providerType("vibe");
export const mistralPlugin: Plugin = {
  id: "mistral",
  providerTypes: () => [mistralAPIProviderType, mistralVibeProviderType],
};
export { MistralProvider } from "./provider.ts";
