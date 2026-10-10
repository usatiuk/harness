import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { GeminiProvider } from "./provider.ts";
export { GeminiProvider } from "./provider.ts";

export const geminiProviderType = defineProviderType({
  type: "gemini-api",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    webSearch: z.boolean().default(false),
  }),
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey, () => null);
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new GeminiProvider({ provider: context.id, apiKey, webSearch: config.webSearch })
          : null;
      },
    };
  },
});
