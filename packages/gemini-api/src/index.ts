import { z } from "zod";
import { defineProviderType, modelMetadataSchema } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { GeminiProvider } from "./provider.ts";
export { GeminiProvider } from "./provider.ts";

export const geminiProviderType = defineProviderType({
  type: "gemini-api",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    models: z
      .record(
        z.string().trim().min(1).max(512),
        modelMetadataSchema.refine(
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
    const auth = instanceApiKeyAuth(context, config.apiKey, () => null);
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new GeminiProvider({
              provider: context.id,
              apiKey,
              webSearch: config.webSearch,
              models: config.models,
            })
          : null;
      },
    };
  },
});
