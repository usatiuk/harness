import type { ModelInfo } from "@harness/protocol";
import type { State } from "./transcript-reducer.ts";

/** Presentation only: the engine's reserve-adjusted compaction trigger is separate. */
export function inputCapacity(checkpoint: State["agentContext"], models: readonly ModelInfo[]) {
  const model =
    checkpoint &&
    models.find(
      (model) => model.provider === checkpoint.provider && model.model === checkpoint.model,
    );
  const used = checkpoint?.usage?.inputTokens;
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
