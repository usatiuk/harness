import type { FileToolsProfile, Plugin } from "@harness/protocol";
import type { CustomProviderConfig } from "@harness/config";
import { CustomOpenAIProvider } from "./custom-openai.ts";
import { CustomAnthropicProvider } from "./custom-anthropic.ts";

/** The shared fields every custom provider option set carries, minus the type-specific presets. */
type CustomOptions = {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** File-editing dialect, forwarded to whichever family the provider uses. */
  fileTools?: FileToolsProfile;
};

// `exactOptionalPropertyTypes` forbids passing `undefined` explicitly, so assemble only present keys.
function optionsFor(id: string, config: CustomProviderConfig): CustomOptions {
  return {
    id,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.fileTools !== undefined ? { fileTools: config.fileTools } : {}),
  };
}

/** Wires one `customProviderConfig` entry into a runnable plugin. The config key is the registry id. */
export function createCustomProviderPlugin(id: string, config: CustomProviderConfig): Plugin {
  if (config.type === "openai-compatible") {
    return {
      id,
      providers: () => [
        new CustomOpenAIProvider({
          ...optionsFor(id, config),
          ...(config.presets !== undefined ? { presets: config.presets } : {}),
          ...(config.sendInstructionsAsSystem !== undefined
            ? { sendInstructionsAsSystem: config.sendInstructionsAsSystem }
            : {}),
        }),
      ],
    };
  }
  return {
    id,
    providers: () => [
      new CustomAnthropicProvider({
        ...optionsFor(id, config),
        ...(config.presets !== undefined ? { presets: config.presets } : {}),
      }),
    ],
  };
}

/** Builds the full custom-provider plugin set from the parsed `customProviders` settings section. */
export function createCustomProviderPlugins(
  configs: Record<string, CustomProviderConfig>,
): Plugin[] {
  return Object.entries(configs).map(([id, config]) => createCustomProviderPlugin(id, config));
}
