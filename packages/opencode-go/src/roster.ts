import type { ModelInfo } from "@harness/protocol";

/** The gateway transport a model streams on. */
export type GoFamily = "chat" | "responses" | "messages";

/** One model in the static compiled roster. */
export interface GoModelSpec {
  model: string;
  family: GoFamily;
  contextWindow: number;
  maxOutputTokens: number;
  /** Kept for capacity math of older conversations; still served by the gateway. */
  deprecated?: boolean;
}

/**
 * Static compiled roster — the gateway's `GET /v1/models` returns bare ids only,
 * so family/limits come from here (models.dev `opencode-go` + the Go docs,
 * snapshot 2026-08-08). Unknown ids dispatch on the default `chat` family.
 */
export const ROSTER: GoModelSpec[] = [
  { model: "grok-4.5", family: "responses", contextWindow: 500_000, maxOutputTokens: 500_000 },
  { model: "glm-5.2", family: "chat", contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  { model: "glm-5.1", family: "chat", contextWindow: 202_752, maxOutputTokens: 32_768 },
  {
    model: "glm-5",
    family: "chat",
    contextWindow: 202_752,
    maxOutputTokens: 32_768,
    deprecated: true,
  },
  { model: "kimi-k3", family: "chat", contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  { model: "kimi-k2.7-code", family: "chat", contextWindow: 262_144, maxOutputTokens: 262_144 },
  { model: "kimi-k2.6", family: "chat", contextWindow: 262_144, maxOutputTokens: 65_536 },
  {
    model: "kimi-k2.5",
    family: "chat",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    deprecated: true,
  },
  { model: "deepseek-v4-pro", family: "chat", contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  {
    model: "deepseek-v4-flash",
    family: "chat",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
  { model: "mimo-v2.5", family: "chat", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { model: "mimo-v2.5-pro", family: "chat", contextWindow: 1_048_576, maxOutputTokens: 128_000 },
  {
    model: "mimo-v2-pro",
    family: "chat",
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    deprecated: true,
  },
  {
    model: "mimo-v2-omni",
    family: "chat",
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
    deprecated: true,
  },
  { model: "hy3", family: "chat", contextWindow: 256_000, maxOutputTokens: 64_000 },
  { model: "hy3-preview", family: "chat", contextWindow: 256_000, maxOutputTokens: 64_000 },
  {
    model: "gpt-5.6-luna",
    family: "responses",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
  },
  { model: "minimax-m3", family: "messages", contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  { model: "minimax-m2.7", family: "messages", contextWindow: 204_800, maxOutputTokens: 131_072 },
  {
    model: "minimax-m2.5",
    family: "messages",
    contextWindow: 204_800,
    maxOutputTokens: 65_536,
    deprecated: true,
  },
  { model: "qwen3.8-max", family: "messages", contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  { model: "qwen3.7-max", family: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { model: "qwen3.7-plus", family: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { model: "qwen3.6-plus", family: "messages", contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  {
    model: "qwen3.5-plus",
    family: "messages",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    deprecated: true,
  },
];

/** The default transport for a model absent from the roster (and for `opencode-go`'s default). */
export const DEFAULT_FAMILY: GoFamily = "chat";

/** Family for a model, falling back to the default chat family for unknown ids. */
export function familyOf(model: string): GoFamily {
  return ROSTER.find((spec) => spec.model === model)?.family ?? DEFAULT_FAMILY;
}

/** Max output for a model; undefined for unknown ids (compaction advice off). */
export function maxOutputOf(model: string): number | undefined {
  return ROSTER.find((spec) => spec.model === model)?.maxOutputTokens;
}

/** The selectable catalog exposed by the provider. */
export function listModels(provider: string): ModelInfo[] {
  return ROSTER.map((spec) => ({
    provider,
    model: spec.model,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
  }));
}
