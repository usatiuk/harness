import type { FileToolsProfile, ModelConfig, ModelInfo } from "@harness/protocol";

/** The model-scoped fields every transport-style custom provider resolves at runtime. */
export interface ModelScope {
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  fileTools?: FileToolsProfile | undefined;
  presets?: Record<string, unknown> | undefined;
}

/** One `ModelInfo` catalog entry per configured model, carrying its own limits and presets. */
export function listScopedModels(
  provider: string,
  models: ReadonlyMap<string, ModelScope>,
): ModelInfo[] {
  return [...models.entries()].map(([model, scope]) => ({
    provider,
    model,
    presets: Object.keys(scope.presets ?? {}).map((value) => ({ value })),
    ...(scope.contextWindow !== undefined ? { contextWindow: scope.contextWindow } : {}),
    ...(scope.maxOutputTokens !== undefined ? { maxOutputTokens: scope.maxOutputTokens } : {}),
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
  if (config.preset && !(config.preset in presets)) {
    throw new Error(
      `unknown preset "${config.preset}" for ${provider}/${config.model} (try: ${Object.keys(presets).join(", ")})`,
    );
  }
}
