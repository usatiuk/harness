import { mergeModelMetadata } from "@harness/protocol";
import type { ModelCapabilities, ModelMetadata, ModelConfig, ModelInfo } from "@harness/protocol";

/** The model-scoped fields every transport-style custom provider resolves at runtime. */
export interface ModelScope extends ModelMetadata {
  presets?: Record<string, unknown> | undefined;
}

export function scopedCapabilities(scope: ModelScope): ModelCapabilities {
  return {
    contentTypes: ["text", "image"],
    toolCalling: true,
    customToolInput: scope.customToolInput ?? { supported: false, grammars: [] },
    preferredEditTool: scope.preferredEditTool ?? "replace",
  };
}

/** One `ModelInfo` catalog entry per configured model, carrying its own limits and presets. */
export function listScopedModels(
  provider: string,
  models: ReadonlyMap<string, ModelScope>,
): ModelInfo[] {
  return [...models.entries()].map(([model, { presets, ...metadata }]) => ({
    ...mergeModelMetadata(provider, [], { [model]: metadata })[0]!,
    presets: Object.keys(presets ?? {}).map((value) => ({ value })),
  }));
}

/** Fails fast on a model the provider doesn't serve or a preset its chosen model doesn't define. */
export function validateScopedConfig(
  provider: string,
  models: ReadonlyMap<string, ModelScope>,
  config: ModelConfig,
): void {
  const scope = models.get(config.model);
  if (!scope) {
    throw new Error(
      `unknown model "${config.model}" for provider ${provider} (try: ${[...models.keys()].join(", ")})`,
    );
  }
  const presets = scope.presets ?? {};
  if (config.preset && !Object.hasOwn(presets, config.preset)) {
    throw new Error(
      `unknown preset "${config.preset}" for ${provider}/${config.model} (try: ${Object.keys(presets).join(", ")})`,
    );
  }
}

/** Resolves one configured model for capability/request shaping; unknown ids are configuration bugs. */
export function scopedModel(
  provider: string,
  models: ReadonlyMap<string, ModelScope>,
  model: string,
): ModelScope {
  const scope = models.get(model);
  if (!scope) throw new Error(`unknown model "${model}" for provider ${provider}`);
  return scope;
}
