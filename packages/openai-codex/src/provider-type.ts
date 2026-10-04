import { z } from "zod";
import { defineProviderType, type ProviderOAuth } from "@harness/protocol";
import { CodexAuth } from "./auth.ts";
import { createCodexProvider } from "./provider.ts";

export const codexProviderType = defineProviderType({
  type: "openai-codex",
  configSchema: z.strictObject({}),
  create(context) {
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
        return (await codex.status()).authenticated ? createCodexProvider(codex, context.id) : null;
      },
    };
  },
});
