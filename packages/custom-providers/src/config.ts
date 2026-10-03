import { z } from "zod";
import { FILE_TOOLS } from "@harness/protocol";
import { apiKeySourceSchema } from "@harness/auth";

const extraBodyExcluding = (reserved: ReadonlySet<string>, transport: string) =>
  z.record(z.string(), z.unknown()).superRefine((body, ctx) => {
    for (const key of Object.keys(body)) {
      if (reserved.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${transport} extraBody cannot override Harness-owned field '${key}'`,
        });
      }
    }
  });

const OPENAI_RESERVED_BODY_FIELDS = new Set([
  "model",
  "input",
  "messages",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "store",
  "include",
  "conversation",
  "previous_response_id",
  "prompt",
  "truncation",
  "background",
  "reasoning",
  "parallel_tool_calls",
  "max_output_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
]);
const ANTHROPIC_RESERVED_BODY_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "stream",
  "max_tokens",
  "thinking",
  "output_config",
  "temperature",
  "top_p",
]);

/** Generation parameters an OpenAI-compatible preset maps to an SDK call. */
const openaiPresetSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  /** Freeform fields merged into the request body (e.g. `seed`, `top_k`). */
  extraBody: extraBodyExcluding(OPENAI_RESERVED_BODY_FIELDS, "OpenAI").optional(),
});

/** Generation parameters an Anthropic-compatible preset maps to an SDK call. */
const anthropicPresetSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** Not native to the Messages API; forwarded via extra_body for backends that accept them. */
  topK: z.number().int().positive().optional(),
  /** Forwarded via extra_body for backends that accept them. */
  minP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().optional(),
  /** Forwarded via extra_body for backends that accept them. */
  repetitionPenalty: z.number().optional(),
  /** Freeform fields merged into the request body (e.g. `chat_template_kwargs`, `seed`). */
  extraBody: extraBodyExcluding(ANTHROPIC_RESERVED_BODY_FIELDS, "Anthropic").optional(),
});

/**
 * Fields every custom provider entry shares. Credentials and the transport dialect are
 * provider-scoped; capacity, `fileTools`, and presets are per model (each model can be
 * trained on a different dialect and offer different sampling).
 */
const customProviderBase = z.strictObject({
  /** Custom endpoint. OpenAI-compatible: include the API root (e.g. `http://host:8000/v1`).
   * Anthropic-compatible: the server root (the SDK appends the Messages path). */
  endpoint: z.string().url(),
  /** Inline API key literal passed to the SDK; keyless local servers require an explicit dummy value. */
  apiKey: z.union([z.string(), apiKeySourceSchema]).default({ stored: true }),
});

/** Model-scoped fields shared by every transport's model entries. */
const customModelBase = z.strictObject({
  /** Model context window in tokens; capacity math (auto-compaction) applies when set. */
  contextWindow: z.number().int().positive().optional(),
  /** Model max output in tokens; reserved when estimating whether the next input fits. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** The file-editing dialect the model is trained on; the workspace plugin selects its tool roster
   * from it. Absent defaults to `string_replace` for the OpenAI-compatible families and
   * `text_editor` for anthropic-compatible. */
  fileTools: z.enum(FILE_TOOLS).optional(),
});

const capacityIssues = (model: {
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  presets?: Record<string, { maxTokens?: number | undefined }> | undefined;
}): { path: (string | number)[]; message: string }[] => {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (
    model.contextWindow !== undefined &&
    model.maxOutputTokens !== undefined &&
    model.maxOutputTokens > model.contextWindow
  ) {
    issues.push({
      path: ["maxOutputTokens"],
      message: "maxOutputTokens cannot exceed contextWindow",
    });
  }
  const presetLimit = model.maxOutputTokens ?? model.contextWindow;
  if (presetLimit !== undefined) {
    for (const [preset, config] of Object.entries(model.presets ?? {})) {
      if (config.maxTokens !== undefined && config.maxTokens > presetLimit) {
        issues.push({
          path: ["presets", preset, "maxTokens"],
          message: "preset maxTokens cannot exceed the model's output capacity",
        });
      }
    }
  }
  return issues;
};

const addCapacityIssues = (
  model: Parameters<typeof capacityIssues>[0],
  addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void,
): void => {
  for (const issue of capacityIssues(model)) addIssue({ code: "custom", ...issue });
};

/** An OpenAI Responses-family model entry: sampling presets keyed by preset name. */
const openaiModelSchema = z
  .strictObject({
    ...customModelBase.shape,
    presets: z.record(z.string(), openaiPresetSchema).optional(),
  })
  .superRefine((model, ctx) => addCapacityIssues(model, (issue) => ctx.addIssue(issue)));

// Chat/completions and the Anthropic Messages transport are both function-only: neither can render
// the freeform `apply_patch` custom tool, so no model of either family may offer that dialect —
// rejected at parse time rather than failing somewhere mid-turn.
const completionsModelSchema = z
  .strictObject({
    ...customModelBase.shape,
    presets: z.record(z.string(), openaiPresetSchema).optional(),
  })
  .superRefine((model, ctx) => addCapacityIssues(model, (issue) => ctx.addIssue(issue)))
  .refine((scope) => scope.fileTools !== "apply_patch", {
    message: "openai-completions-compatible supports only function tools (not 'apply_patch')",
    path: ["fileTools"],
  });

/** An anthropic-compatible model entry: richer preset knobs forwarded via extra_body. */
const anthropicModelSchema = z
  .strictObject({
    ...customModelBase.shape,
    presets: z.record(z.string(), anthropicPresetSchema).optional(),
  })
  .superRefine((model, ctx) => addCapacityIssues(model, (issue) => ctx.addIssue(issue)))
  .refine((scope) => scope.fileTools !== "apply_patch", {
    message: "anthropic-compatible supports only function tools (not 'apply_patch')",
    path: ["fileTools"],
  });

/** A companion provider must serve at least one non-empty model name; an empty catalog would
 * parse cleanly but silently contribute nothing to the model registry. */
const modelsOf = <S extends z.ZodTypeAny>(modelSchema: S) =>
  z.record(z.string().min(1), modelSchema).refine((models) => Object.keys(models).length > 0, {
    message: "requires at least one model",
  });

export const customProviderSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...customProviderBase.shape,
    type: z.literal("openai-responses-compatible"),
    models: modelsOf(openaiModelSchema),
    /**
     * Some OpenAI Responses-compatible backends (e.g. OVMS) accept the Responses request shape but
     * silently drop the top-level `instructions` field. When set, the provider renders
     * `ModelRequest.instructions` as a leading `system` input message instead, so those backends still
     * receive the system context.
     */
    sendInstructionsAsSystem: z.boolean().optional(),
  }),
  z.strictObject({
    ...customProviderBase.shape,
    type: z.literal("openai-completions-compatible"),
    models: modelsOf(completionsModelSchema),
  }),
  z.strictObject({
    ...customProviderBase.shape,
    type: z.literal("anthropic-compatible"),
    models: modelsOf(anthropicModelSchema),
  }),
]);

export type CustomProviderConfig = z.infer<typeof customProviderSchema>;
/** One model entry in an OpenAI-family custom provider. */
export type CustomOpenAIModelConfig = z.infer<typeof openaiModelSchema>;
/** One model entry in a completions-compatible custom provider (rejects `apply_patch`). */
export type CustomCompletionsModelConfig = z.infer<typeof completionsModelSchema>;
/** One model entry in an anthropic-compatible custom provider. */
export type CustomAnthropicModelConfig = z.infer<typeof anthropicModelSchema>;
/** Sampling knobs an OpenAI-compatible preset maps onto the Responses request. */
export type OpenAIPreset = z.infer<typeof openaiPresetSchema>;
/** Sampling knobs an Anthropic-compatible preset maps onto the Messages request. */
export type AnthropicPreset = z.infer<typeof anthropicPresetSchema>;
