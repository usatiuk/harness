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
    webSearch: z.boolean().default(true).meta({
      harnessSetting: true,
      title: "Web search",
      description: "Allow this provider to search the web when needed. Enabled by default.",
    }),
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
              webSearch: config.webSearch,
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
