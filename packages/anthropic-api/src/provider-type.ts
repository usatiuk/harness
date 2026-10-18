import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { AnthropicProvider, anthropicModelConfigSchema } from "@harness/anthropic-core";
import { apiKeyCredentials } from "./index.ts";

export const anthropicProviderType = defineProviderType({
  type: "anthropic-api",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    baseUrl: z.url().optional(),
    models: z
      .record(
        z.string().trim().min(1).max(512),
        anthropicModelConfigSchema.refine(
          (model) => !model.customToolInput?.supported,
          "This adapter supports JSON tool input only",
        ),
      )
      .default({}),
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
              modelOverrides: config.models,
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
