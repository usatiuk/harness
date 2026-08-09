import type { Plugin } from "@harness/protocol";
import type { CustomProviderConfig } from "@harness/config";
import { CustomOpenAIProvider } from "./custom-openai.ts";
import { CustomOpenAICompletionsProvider } from "./custom-openai-completions.ts";
import { CustomAnthropicProvider } from "./custom-anthropic.ts";

/** Wires one `customProviderConfig` entry into a runnable plugin. The config key is the registry id. */
export function createCustomProviderPlugin(id: string, config: CustomProviderConfig): Plugin {
  switch (config.type) {
    case "openai-responses-compatible":
      return {
        id,
        providers: () => [
          new CustomOpenAIProvider({
            id,
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            models: config.models,
            ...(config.sendInstructionsAsSystem !== undefined
              ? { sendInstructionsAsSystem: config.sendInstructionsAsSystem }
              : {}),
          }),
        ],
      };
    case "openai-completions-compatible":
      return {
        id,
        providers: () => [
          new CustomOpenAICompletionsProvider({
            id,
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            models: config.models,
          }),
        ],
      };
    case "anthropic-compatible":
      return {
        id,
        providers: () => [
          new CustomAnthropicProvider({
            id,
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            models: config.models,
          }),
        ],
      };
  }
}

/** Builds the full custom-provider plugin set from the parsed `customProviders` settings section. */
export function createCustomProviderPlugins(
  configs: Record<string, CustomProviderConfig>,
): Plugin[] {
  return Object.entries(configs).map(([id, config]) => createCustomProviderPlugin(id, config));
}
