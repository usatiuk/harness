import type { ModelInfo } from "@harness/protocol";

/** The gateway transport a model streams on. */
export type GoFamily = "chat" | "responses" | "messages";

export type GoReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type GoPresetControl =
  | { kind: "effort"; effort: GoReasoningEffort }
  | { kind: "thinking"; thinking: "disabled" | "adaptive" }
  | { kind: "thinking-budget"; budgetTokens: number };

/** One model-scoped preset and the exact native control it selects. */
export interface GoPresetSpec {
  value: string;
  label?: string;
  control: GoPresetControl;
}

/** One model in the static compiled roster. */
export interface GoModelSpec {
  model: string;
  family: GoFamily;
  contextWindow: number;
  maxOutputTokens: number;
  presets?: GoPresetSpec[];
  defaultPreset?: string;
}

const efforts = (...values: GoReasoningEffort[]): GoPresetSpec[] =>
  values.map((value) => ({ value, control: { kind: "effort", effort: value } }));

// OpenCode caps catalog-derived thinking budgets at 32K, then uses half/max variants.
const thinkingBudgets = (): GoPresetSpec[] => [
  { value: "high", control: { kind: "thinking-budget", budgetTokens: 16_000 } },
  { value: "max", control: { kind: "thinking-budget", budgetTokens: 31_999 } },
];

/**
 * Static compiled roster — the gateway's `GET /v1/models` returns bare ids only,
 * so family/limits come from here (models.dev `opencode-go` + the Go docs,
 * snapshot 2026-08-09). Only rostered ids are accepted by the provider.
 */
export const ROSTER: GoModelSpec[] = [
  {
    model: "grok-4.5",
    family: "chat",
    contextWindow: 500_000,
    maxOutputTokens: 500_000,
    presets: efforts("low", "medium", "high"),
  },
  {
    model: "glm-5.2",
    family: "chat",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    presets: efforts("high", "max"),
  },
  { model: "glm-5.1", family: "chat", contextWindow: 202_752, maxOutputTokens: 32_768 },
  {
    model: "glm-5",
    family: "chat",
    contextWindow: 202_752,
    maxOutputTokens: 32_768,
  },
  {
    model: "kimi-k3",
    family: "chat",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    presets: efforts("max"),
  },
  { model: "kimi-k2.7-code", family: "chat", contextWindow: 262_144, maxOutputTokens: 262_144 },
  { model: "kimi-k2.6", family: "chat", contextWindow: 262_144, maxOutputTokens: 65_536 },
  {
    model: "kimi-k2.5",
    family: "chat",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
  },
  {
    model: "deepseek-v4-pro",
    family: "chat",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    presets: efforts("high", "max"),
  },
  {
    model: "deepseek-v4-flash",
    family: "chat",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    presets: efforts("low", "high", "max"),
  },
  { model: "mimo-v2.5", family: "chat", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { model: "mimo-v2.5-pro", family: "chat", contextWindow: 1_048_576, maxOutputTokens: 128_000 },
  {
    model: "mimo-v2-pro",
    family: "chat",
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
  },
  {
    model: "mimo-v2-omni",
    family: "chat",
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
  },
  {
    model: "hy3",
    family: "chat",
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    presets: efforts("none", "low", "high"),
  },
  { model: "hy3-preview", family: "chat", contextWindow: 256_000, maxOutputTokens: 64_000 },
  {
    model: "gpt-5.6-luna",
    family: "responses",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    presets: efforts("none", "low", "medium", "high", "xhigh", "max"),
    defaultPreset: "medium",
  },
  {
    model: "minimax-m3",
    family: "messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    presets: [
      { value: "none", label: "Thinking off", control: { kind: "thinking", thinking: "disabled" } },
      {
        value: "thinking",
        label: "Thinking on",
        control: { kind: "thinking", thinking: "adaptive" },
      },
    ],
  },
  { model: "minimax-m2.7", family: "messages", contextWindow: 204_800, maxOutputTokens: 131_072 },
  {
    model: "minimax-m2.5",
    family: "messages",
    contextWindow: 204_800,
    maxOutputTokens: 65_536,
  },
  {
    model: "qwen3.8-max",
    family: "messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    presets: thinkingBudgets(),
  },
  {
    model: "qwen3.7-max",
    family: "messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    presets: thinkingBudgets(),
  },
  {
    model: "qwen3.7-plus",
    family: "messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    presets: thinkingBudgets(),
  },
  {
    model: "qwen3.6-plus",
    family: "messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    presets: thinkingBudgets(),
  },
  {
    model: "qwen3.5-plus",
    family: "messages",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    presets: thinkingBudgets(),
  },
];

/** Compiled metadata for one rostered model. */
export function modelSpec(model: string): GoModelSpec | undefined {
  return ROSTER.find((spec) => spec.model === model);
}

/** Family for one rostered model. Configuration validation establishes this invariant. */
export function familyOf(model: string): GoFamily | undefined {
  return modelSpec(model)?.family;
}

/** Max output for a model; undefined for unknown ids (compaction advice off). */
export function maxOutputOf(model: string): number | undefined {
  return modelSpec(model)?.maxOutputTokens;
}

/** Selected native preset control, including a compiled default when the selection omits one. */
export function presetFor(model: string, selected?: string): GoPresetSpec | undefined {
  const spec = modelSpec(model);
  const value = selected ?? spec?.defaultPreset;
  return value ? spec?.presets?.find((preset) => preset.value === value) : undefined;
}

/** The selectable catalog exposed by the provider. */
export function listModels(provider: string): ModelInfo[] {
  return ROSTER.map((spec) => ({
    provider,
    model: spec.model,
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
