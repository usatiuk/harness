import {
  defineProviderType,
  type ModelProvider,
  type Plugin,
  type ProviderType,
} from "@harness/protocol";
import { instanceApiKeyAuth } from "@harness/auth";
import type { z } from "zod";
import { customProviderSchema, type CustomProviderConfig } from "./config.ts";
import { CustomOpenAIProvider } from "./custom-openai.ts";
import { CustomOpenAICompletionsProvider } from "./custom-openai-completions.ts";
import { CustomAnthropicProvider } from "./custom-anthropic.ts";

/** Wires one `customProviderConfig` entry into a runnable plugin. The config key is the registry id. */
export function createCustomProviderPlugin(id: string, raw: unknown): Plugin {
  const config = customProviderSchema.parse(raw);
  if (typeof config.apiKey !== "string")
    throw new Error("Credential references require provider instance construction");
  const provider = buildProvider(id, config, config.apiKey);
  return { id, providers: () => [provider] };
}

function buildProvider(id: string, config: CustomProviderConfig, apiKey: string): ModelProvider {
  switch (config.type) {
    case "openai-responses-compatible":
      return new CustomOpenAIProvider({
        id,
        endpoint: config.endpoint,
        apiKey,
        models: config.models,
        ...(config.sendInstructionsAsSystem !== undefined
          ? { sendInstructionsAsSystem: config.sendInstructionsAsSystem }
          : {}),
      });
    case "openai-completions-compatible":
      return new CustomOpenAICompletionsProvider({
        id,
        endpoint: config.endpoint,
        apiKey,
        models: config.models,
      });
    case "anthropic-compatible":
      return new CustomAnthropicProvider({
        id,
        endpoint: config.endpoint,
        apiKey,
        models: config.models,
      });
  }
}

/** Builds the full custom-provider plugin set from the parsed `customProviders` settings section. */
export function createCustomProviderPlugins(configs: Record<string, unknown>): Plugin[] {
  return Object.entries(configs).map(([id, config]) => createCustomProviderPlugin(id, config));
}

/** Compatible transports use the same named connection/auth path as built-in providers. */
function providerType<C extends Omit<CustomProviderConfig, "type">>(
  type: CustomProviderConfig["type"],
  configSchema: z.ZodType<C>,
): ProviderType {
  return defineProviderType({
    type,
    configSchema,
    create(context, config) {
      const resolved = { ...config, type } as CustomProviderConfig;
      const source = resolved.apiKey;
      const auth = typeof source === "string" ? undefined : instanceApiKeyAuth(context, source);
      return {
        ...(auth ? { auth } : {}),
        async buildProvider() {
          const key = typeof source === "string" ? source : await auth!.getKey();
          return key === null ? null : buildProvider(context.id, resolved, key);
        },
      };
    },
  });
}

const [responses, completions, messages] = customProviderSchema.options;
export const customProviderTypes = [
  providerType("openai-responses-compatible", responses.omit({ type: true })),
  providerType("openai-completions-compatible", completions.omit({ type: true })),
  providerType("anthropic-compatible", messages.omit({ type: true })),
];

export const customProvidersPlugin: Plugin = {
  id: "custom-providers",
  providerTypes: () => customProviderTypes,
};
