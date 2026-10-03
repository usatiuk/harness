import { z } from "zod";
import { defineProviderType } from "@harness/protocol";
import { apiKeySourceSchema, instanceApiKeyAuth } from "@harness/auth";
import { apiKeyCredentials as openaiCredentials } from "@harness/openai-api";
import { apiKeyCredentials as anthropicCredentials } from "@harness/anthropic-api";
import { OpenCodeGoProvider } from "./provider.ts";
import { OPENCODE_GO_BASE } from "./index.ts";

export const openCodeGoProviderType = defineProviderType({
  type: "opencode-go",
  configSchema: z.strictObject({ apiKey: apiKeySourceSchema.default({ stored: true }) }),
  create(context, config) {
    const auth = instanceApiKeyAuth(context, config.apiKey);
    return {
      auth,
      async buildProvider() {
        const apiKey = await auth.getKey();
        return apiKey
          ? new OpenCodeGoProvider({
              provider: context.id,
              openai: openaiCredentials({ apiKey, baseURL: OPENCODE_GO_BASE }),
              anthropic: anthropicCredentials({ apiKey, baseURL: "https://opencode.ai/zen/go" }),
            })
          : null;
      },
    };
  },
});
