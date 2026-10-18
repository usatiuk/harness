import { openAIModelConfigSchema } from "@harness/openai-core";
import { z } from "zod";
import { defineProviderType, type ProviderOAuth } from "@harness/protocol";
import { CodexAuth } from "./auth.ts";
import { createCodexProvider } from "./provider.ts";

export const codexProviderType = defineProviderType({
  type: "openai-codex",
  configSchema: z.strictObject({
    models: z.record(z.string().min(1), openAIModelConfigSchema).default({}),
    webSearch: z.boolean().default(true).meta({
      harnessSetting: true,
      title: "Web search",
      description: "Allow this provider to search the web when needed. Enabled by default.",
    }),
  }),
  create(context, config) {
    const codex = new CodexAuth({ store: context.secrets });
    const auth: ProviderOAuth = {
      kind: "oauth",
      id: context.id,
      label: context.label,
      login: async (opts) => {
        if (opts.flow === "device") await codex.loginWithDeviceCode(opts);
        else await codex.loginWithBrowser(opts);
      },
      status: async () => {
        const status = await codex.status();
        return {
          authenticated: status.authenticated,
          ...(status.authenticated ? { source: "stored" as const } : {}),
          ...(status.email ? { detail: status.email } : {}),
          ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
        };
      },
      logout: () => codex.logout(),
    };
    return {
      auth,
      async buildProvider() {
        return (await codex.status()).authenticated
          ? createCodexProvider(codex, context.id, config.webSearch, config.models)
          : null;
      },
    };
  },
});
