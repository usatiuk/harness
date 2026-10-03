import { z } from "zod";
import { defineProviderType, type ProviderOAuth } from "@harness/protocol";
import { CodexAuth } from "./auth.ts";
import { codexPlugin } from "./plugin.ts";

export const codexProviderType = defineProviderType({
  type: "openai-codex",
  configSchema: z.strictObject({}),
  create(context) {
    const codex = new CodexAuth({ store: context.secrets, storeKey: "oauth" });
    const auth: ProviderOAuth = {
      kind: "oauth",
      id: context.id,
      label: context.label,
      login: async (opts) => {
        await codex.loginWithBrowser(opts);
      },
      status: async () => {
        const status = await codex.status();
        return {
          authenticated: status.authenticated,
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
          ? codexPlugin(codex, context.id).providers!()[0]!
          : null;
      },
    };
  },
});
