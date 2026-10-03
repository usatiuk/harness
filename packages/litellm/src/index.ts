import { defineProviderType, type Plugin } from "@harness/protocol";
import { instanceApiKeyAuth } from "@harness/auth";
import { liteLLMConfigSchema } from "./config.ts";
import { LiteLLMProvider } from "./provider.ts";

export const liteLLMProviderType = defineProviderType({
  type: "litellm",
  configSchema: liteLLMConfigSchema,
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey);
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey ? new LiteLLMProvider(context.id, config, apiKey) : null;
      },
    };
  },
});
export const liteLLMPlugin: Plugin = { id: "litellm", providerTypes: () => [liteLLMProviderType] };
export { LiteLLMProvider } from "./provider.ts";
export { liteLLMConfigSchema } from "./config.ts";
