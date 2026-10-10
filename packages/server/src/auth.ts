import {
  ProviderCredentialError,
  type ModelConfig,
  type PluginEntry,
  type ProviderInstance,
  type ProviderType,
} from "@harness/protocol";
import { formatIssue, type SettingsDoc } from "@harness/config";
import { z } from "zod";
import type { SecretStore } from "@harness/secrets";
import type { AuthMethod } from "@harness/auth";
import { anthropicProviderType } from "@harness/anthropic-api";
import { openAIProviderType } from "@harness/openai-api";
import { openCodeGoProviderType } from "@harness/opencode-go";
import { codexProviderType } from "@harness/openai-codex";
import { geminiProviderType } from "@harness/gemini-api";
import { liteLLMPlugin } from "@harness/litellm";
import { customProvidersPlugin } from "@harness/custom-providers";
import { mistralPlugin } from "@harness/mistral";

export interface AuthEntry {
  method: AuthMethod;
  defaultModel?: ModelConfig;
}
export class ProviderConfigurationError extends Error {}

export interface ProviderEntry {
  id: string;
  label: string;
  type: string;
  instance: ProviderInstance;
  defaultModel?: ModelConfig;
}

/** Package contributions are collected before constructing any connection. */
export const providerPlugins: PluginEntry[] = [
  liteLLMPlugin,
  customProvidersPlugin,
  mistralPlugin,
  { id: "openai-api", providerTypes: () => [openAIProviderType] },
  { id: "anthropic-api", providerTypes: () => [anthropicProviderType] },
  { id: "opencode-go", providerTypes: () => [openCodeGoProviderType] },
  { id: "openai-codex", providerTypes: () => [codexProviderType] },
  { id: "gemini-api", providerTypes: () => [geminiProviderType] },
];

const defaults = () => [
  {
    id: "openai",
    type: "openai-api",
    label: "OpenAI (API key)",
    config: { apiKey: { env: "OPENAI_API_KEY", stored: true } },
    model: process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
  },
  {
    id: "anthropic",
    type: "anthropic-api",
    label: "Anthropic (API key)",
    config: { apiKey: { env: "ANTHROPIC_API_KEY", stored: true } },
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  },
  {
    id: "opencode-go",
    type: "opencode-go",
    label: "OpenCode Go (API key)",
    config: { apiKey: { env: "OPENCODE_API_KEY", stored: true } },
    model: process.env.OPENCODE_MODEL ?? "gpt-5.6-luna",
  },
  {
    id: "openai-codex",
    type: "openai-codex",
    label: "ChatGPT / Codex",
    config: {},
    model: "gpt-6.1-sol",
  },
  {
    id: "mistral-api",
    type: "mistral-api",
    label: "Mistral API (API key)",
    config: { apiKey: { env: "MISTRAL_API_KEY", stored: true } },
    model: "mistral-medium-latest",
  },
  {
    id: "mistral-vibe",
    type: "mistral-vibe",
    label: "Mistral Vibe (API key)",
    config: { apiKey: { env: "MISTRAL_VIBE_API_KEY", stored: true } },
    model: "mistral-vibe-cli-latest",
  },
];

export function prepareProviderEntries(
  settings: SettingsDoc = {},
  plugins: readonly PluginEntry[] = providerPlugins,
  source?: string,
): (store: SecretStore) => Map<string, ProviderEntry> {
  const types = new Map<string, ProviderType>();
  for (const plugin of plugins)
    for (const type of plugin.providerTypes?.() ?? []) {
      if (types.has(type.type)) throw new Error(`Duplicate provider type '${type.type}'`);
      types.set(type.type, type);
    }
  const builtin = defaults();
  const configured = new Map(builtin.map(({ id, ...entry }) => [id, entry]));
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    if (id === "demo") throw new Error(`Duplicate provider instance '${id}'`);
    const prior = configured.get(id);
    if (prior && prior.type !== entry.type)
      throw new Error(`Built-in instance '${id}' must retain type '${prior.type}'`);
    configured.set(id, {
      ...entry,
      label: entry.label ?? prior?.label ?? id,
      model: prior?.model ?? "",
    });
  }
  // Parse every instance before touching a credential backend or starting network discovery.
  const prepared = [...configured].map(([id, entry]) => {
    const type = types.get(entry.type);
    if (!type) throw new Error(`Unknown provider type '${entry.type}' for instance '${id}'`);
    try {
      return { id, entry, create: type.prepare(entry.config) };
    } catch (cause) {
      if (!(cause instanceof z.ZodError)) throw cause;
      const section = `providers.${id}.config`;
      throw new ProviderConfigurationError(
        `Invalid config for provider instance '${id}' (${entry.type})${source ? ` in ${source}` : ""}: ${section}.${formatIssue(cause)}`,
        { cause },
      );
    }
  });
  return (store) =>
    new Map(
      prepared.map(({ id, entry, create }) => {
        const slot = (key: string) =>
          `provider-instance:${encodeURIComponent(id)}:${encodeURIComponent(key)}`;
        const instance = create({
          id,
          label: entry.label,
          secrets: {
            get: async (key) => {
              try {
                return await store.get(slot(key));
              } catch (error) {
                let cause: unknown = error;
                while (cause instanceof Error) {
                  if (
                    "code" in cause &&
                    ["EACCES", "EPERM", "EBUSY", "EIO"].includes(String(cause.code))
                  )
                    throw new ProviderCredentialError();
                  cause = cause.cause;
                }
                throw error;
              }
            },
            set: (key, value) => store.set(slot(key), value),
            delete: (key) => store.delete(slot(key)),
          },
        });
        if (instance.auth && instance.auth.id !== id)
          throw new Error(
            `Provider type '${entry.type}' returned mismatched authentication identity`,
          );
        return [
          id,
          {
            id,
            label: entry.label,
            type: entry.type,
            instance,
            ...(entry.model ? { defaultModel: { provider: id, model: entry.model } } : {}),
          },
        ];
      }),
    );
}

export function providerEntries(
  store: SecretStore,
  settings: SettingsDoc = {},
  plugins: readonly PluginEntry[] = providerPlugins,
): Map<string, ProviderEntry> {
  return prepareProviderEntries(settings, plugins)(store);
}

/** Auth commands and the server share the same plugin-owned connection definitions. */
export function authRegistry(
  store: SecretStore,
  settings: SettingsDoc = {},
): Map<string, AuthEntry> {
  return authEntries(providerEntries(store, settings));
}

export function authEntries(entries: ReadonlyMap<string, ProviderEntry>): Map<string, AuthEntry> {
  const result = new Map<string, AuthEntry>();
  for (const entry of entries.values()) {
    if (!entry.instance.auth) continue;
    result.set(entry.id, {
      method: entry.instance.auth,
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    });
  }
  return result;
}
