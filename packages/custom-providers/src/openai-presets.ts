import type { OpenAIPreset } from "@harness/config";

/** Loose view of the SDK request so presets can touch freeform extra fields. */
export type RequestParams = Record<string, unknown>;

/** The request field that carries the output cap: chat uses `max_tokens`, Responses uses `max_output_tokens`. */
export type TokenField = "max_tokens" | "max_output_tokens";

/** Merges one configured preset's sampling knobs onto a built Responses/chat request. */
export function applyOpenAIPreset(
  params: RequestParams,
  tokenField: TokenField,
  preset?: OpenAIPreset,
): void {
  if (!preset) return;
  if (preset.temperature !== undefined) params.temperature = preset.temperature;
  if (preset.topP !== undefined) params.top_p = preset.topP;
  if (preset.maxTokens !== undefined) params[tokenField] = preset.maxTokens;
  if (preset.frequencyPenalty !== undefined) params.frequency_penalty = preset.frequencyPenalty;
  if (preset.presencePenalty !== undefined) params.presence_penalty = preset.presencePenalty;
  Object.assign(params, preset.extraBody);
}
