import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { AnthropicProvider } from "@harness/anthropic-core";
import { apiKeyCredentials } from "./index.ts";

export const anthropicProviderType = defineProviderType({
  type: "anthropic-api",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    baseUrl: z.url().optional(),
  }),
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey, (key) =>
      key.startsWith("sk-ant-") ? null : "Anthropic keys start with 'sk-ant-'",
    );
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new AnthropicProvider({
              provider: context.id,
              credentials: apiKeyCredentials({
                apiKey,
                ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
              }),
            })
          : null;
      },
    };
  },
});
