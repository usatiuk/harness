import { z } from "zod";
import { defineProviderType, type Plugin } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { MistralProvider } from "./provider.ts";
import type { MistralMode } from "./catalog.ts";
import { configuredModelsSchema } from "./config.ts";

function providerType(mode: MistralMode) {
  return defineProviderType({
    type: `mistral-${mode}`,
    configSchema: z.strictObject({
      apiKey: apiKeySourceSchema.default({ stored: true }),
      webSearch: z.boolean().default(true).meta({
        harnessSetting: true,
        title: "Web search",
        description: "Allow this provider to search the web when needed. Enabled by default.",
      }),
      models: configuredModelsSchema.default({}),
    }),
    create(context, config) {
      const auth = instanceApiKeyAuth(context, config.apiKey);
      return {
        auth,
        async buildProvider() {
          const key = await auth.getKey();
          return key
            ? new MistralProvider(context.id, mode, key, fetch, config.webSearch, config.models)
            : null;
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
