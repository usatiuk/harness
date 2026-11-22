import type { ModelInfo } from "@harness/protocol";

/** Presentation only: the engine's reserve-adjusted compaction trigger is separate. */
export function inputCapacity(model: ModelInfo | undefined, used: number | undefined) {
  const limit = model?.maxInputTokens ?? model?.contextWindow;
  const basis =
    model?.maxInputTokens !== undefined
      ? ("input limit" as const)
      : model?.contextWindow !== undefined
        ? ("shared context window" as const)
        : undefined;
  const percent =
    used !== undefined && limit !== undefined ? Math.round((100 * used) / limit) : undefined;
  return { model, used, limit, basis, percent };
}
