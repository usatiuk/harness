import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { apiKeyCredentials as openaiCredentials } from "@harness/openai-api";
import { apiKeyCredentials as anthropicCredentials } from "@harness/anthropic-api";
import { OpenCodeGoProvider } from "./provider.ts";
import { configuredModelSchema } from "./config.ts";
import { GO_OPENAI_BASE, GO_ANTHROPIC_BASE } from "./catalog.ts";

export const openCodeGoProviderType = defineProviderType({
  type: "opencode-go",
  configSchema: z.strictObject({
    apiKey: apiKeySourceSchema.default({ stored: true }),
    models: z.record(z.string().trim().min(1).max(512), configuredModelSchema).default({}),
  }),
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey);
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new OpenCodeGoProvider({
              provider: context.id,
              models: config.models,
              openai: openaiCredentials({ apiKey, baseURL: GO_OPENAI_BASE }),
              anthropic: anthropicCredentials({ apiKey, baseURL: GO_ANTHROPIC_BASE }),
            })
          : null;
      },
    };
  },
});
