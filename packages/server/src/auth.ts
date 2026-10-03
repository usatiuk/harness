import type { ModelConfig, Plugin } from "@harness/protocol";
import type { SecretStore } from "@harness/secrets";
import { ApiKeyAuth, type AuthMethod, type OAuthMethod } from "@harness/auth";
import { createAnthropicPlugin } from "@harness/anthropic-api";
import { createOpenAIPlugin } from "@harness/openai-api";
import { createOpenCodeGoPlugin } from "@harness/opencode-go";
import { CodexAuth, codexPlugin } from "@harness/openai-codex";

/** A provider's sign-in method plus how an authenticated session becomes a runnable plugin. */
export interface AuthEntry {
  method: AuthMethod;
  /** The plugin to register when authenticated, or null when there are no credentials. */
  buildPlugin(): Promise<Plugin | null>;
  /** The model `auth login` records as the global default. */
  defaultModel: ModelConfig;
}

/** Wraps the Codex OAuth lifecycle in the generic `OAuthMethod` seam. */
function codexMethod(auth: CodexAuth): OAuthMethod {
  return {
    kind: "oauth",
    id: "openai-codex",
    label: "ChatGPT / Codex",
    login: async ({ onUrl, signal }) => {
      await auth.loginWithBrowser({ onUrl, ...(signal ? { signal } : {}) });
    },
    status: async () => {
      const s = await auth.status();
      if (!s.authenticated) return { authenticated: false };
      const detail = s.email ?? (s.accountId ? `account ${s.accountId}` : undefined);
      return {
        authenticated: true,
        ...(detail !== undefined ? { detail } : {}),
        ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
      };
    },
    logout: () => auth.logout(),
  };
}

/** Builds an API-key entry: the env var or a stored key lights up the provider's plugin. */
function apiKeyEntry(opts: {
  id: string;
  label: string;
  envVar: string;
  store: SecretStore;
  defaultModel: ModelConfig;
  validate: (key: string) => string | null;
  createPlugin: (init: { apiKey: string }) => Plugin;
}): [string, AuthEntry] {
  const method = new ApiKeyAuth({
    id: opts.id,
    label: opts.label,
    store: opts.store,
    envVar: opts.envVar,
    validate: opts.validate,
  });
  return [
    opts.id,
    {
      method,
      defaultModel: opts.defaultModel,
      buildPlugin: async () => {
        const apiKey = await method.getKey();
        return apiKey ? opts.createPlugin({ apiKey }) : null;
      },
    },
  ];
}

/**
 * The providers a user can sign in to. Both the `auth` command and the composition root iterate
 * this map, so adding a provider is one new entry here.
 */
export function authRegistry(store: SecretStore): Map<string, AuthEntry> {
  const codex = new CodexAuth({ store });
  return new Map<string, AuthEntry>([
    apiKeyEntry({
      id: "openai",
      label: "OpenAI (API key)",
      envVar: "OPENAI_API_KEY",
      store,
      defaultModel: { provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-6.1-sol" },
      validate: (k) => (k.startsWith("sk-") ? null : "OpenAI keys start with 'sk-'"),
      createPlugin: ({ apiKey }) => createOpenAIPlugin({ apiKey }),
    }),
    apiKeyEntry({
      id: "anthropic",
      label: "Anthropic (API key)",
      envVar: "ANTHROPIC_API_KEY",
      store,
      defaultModel: {
        provider: "anthropic",
        model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
      },
      validate: (k) => (k.startsWith("sk-ant-") ? null : "Anthropic keys start with 'sk-ant-'"),
      createPlugin: ({ apiKey }) => createAnthropicPlugin({ apiKey }),
    }),
    apiKeyEntry({
      id: "opencode-go",
      label: "OpenCode Go (API key)",
      envVar: "OPENCODE_API_KEY",
      store,
      defaultModel: {
        provider: "opencode-go",
        model: process.env.OPENCODE_MODEL ?? "gpt-5.6-luna",
      },
      validate: (k) => (k.trim().length > 0 ? null : "OpenCode Go keys must not be empty"),
      createPlugin: ({ apiKey }) => createOpenCodeGoPlugin({ apiKey }),
    }),
    [
      "openai-codex",
      {
        method: codexMethod(codex),
        defaultModel: { provider: "openai-codex", model: "gpt-6.1-sol" },
        buildPlugin: async () => ((await codex.status()).authenticated ? codexPlugin(codex) : null),
      },
    ],
  ]);
}
