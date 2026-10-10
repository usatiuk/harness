import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { OpenAIResponsesProvider } from "@harness/openai-core";
import { apiKeyCredentials } from "./index.ts";

export const openAIProviderType = defineProviderType({
  type: "openai-api",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    baseUrl: z.url().optional(),
    webSearch: z.boolean().default(false),
  }),
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey, (key) =>
      key.startsWith("sk-") ? null : "OpenAI keys start with 'sk-'",
    );
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new OpenAIResponsesProvider({
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
