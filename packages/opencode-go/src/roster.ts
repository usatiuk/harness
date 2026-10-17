import type { ModelInfo } from "@harness/protocol";
import snapshot from "./models-dev.snapshot.json" with { type: "json" };
import { parseCatalog, type GoModelSpec, type GoFamily, type GoPresetSpec } from "./catalog.ts";

/** Offline Models.dev Go snapshot from October 16, 2026; input modalities refreshed October 17. */
export const ROSTER: readonly GoModelSpec[] = parseCatalog(snapshot).models;

/** Compiled metadata for one rostered model. */
export function modelSpec(
  model: string,
  models: readonly GoModelSpec[] = ROSTER,
): GoModelSpec | undefined {
  return models.find((spec) => spec.model === model);
}

/** Family for one rostered model. Configuration validation establishes this invariant. */
export function familyOf(
  model: string,
  models: readonly GoModelSpec[] = ROSTER,
): GoFamily | undefined {
  return modelSpec(model, models)?.family;
}

/** Max output for a model; undefined for unknown ids (compaction advice off). */
export function maxOutputOf(
  model: string,
  models: readonly GoModelSpec[] = ROSTER,
): number | undefined {
  return modelSpec(model, models)?.maxOutputTokens;
}

/** Selected native preset control, including a compiled default when the selection omits one. */
export function presetFor(
  model: string,
  selected?: string,
  models: readonly GoModelSpec[] = ROSTER,
): GoPresetSpec | undefined {
  const spec = modelSpec(model, models);
  const value = selected ?? spec?.defaultPreset;
  return value ? spec?.presets?.find((preset) => preset.value === value) : undefined;
}

/** The selectable catalog exposed by the provider. */
export function listModels(provider: string, models: readonly GoModelSpec[] = ROSTER): ModelInfo[] {
  return models.map((spec) => ({
    provider,
    model: spec.model,
    ...(spec.supportsImages !== undefined ? { supportsImages: spec.supportsImages } : {}),
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
    ...(spec.maxInputTokens !== undefined ? { maxInputTokens: spec.maxInputTokens } : {}),
    ...(spec.presets
      ? {
          presets: spec.presets.map(({ value, label }) => ({ value, ...(label ? { label } : {}) })),
        }
      : {}),
    ...(spec.defaultPreset ? { defaultPreset: spec.defaultPreset } : {}),
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
  }));
}
