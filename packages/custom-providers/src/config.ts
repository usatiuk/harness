import { z } from "zod";
import { modelMetadataSchema, sessionIdHeaderSchema } from "@harness/protocol";
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
  "prompt_cache_key",
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
 * provider-scoped; model metadata and sampling presets are per model.
 */
const customProviderBase = z.strictObject({
  /** Custom endpoint. OpenAI-compatible: include the API root (e.g. `http://host:8000/v1`).
   * Anthropic-compatible: the server root (the SDK appends the Messages path). */
  endpoint: z.url({ protocol: /^https?$/ }),
  /** Per-request header receiving the stable conversation ID, e.g. OpenRouter's `x-session-id`. */
  sessionIdHeader: sessionIdHeaderSchema.optional(),
  /** Inline API key literal passed to the SDK; keyless local servers require an explicit dummy value. */
  apiKey: z.union([z.string(), apiKeySourceSchema]).default({ stored: true }),
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
    ...modelMetadataSchema.shape,
    presets: z.record(z.string(), openaiPresetSchema).optional(),
  })
  .superRefine((model, ctx) => addCapacityIssues(model, (issue) => ctx.addIssue(issue)));

// Function-only adapters can still offer patches using the JSON fallback.
const completionsModelSchema = openaiModelSchema.refine(
  (scope) => !scope.customToolInput?.supported,
  {
    message: "openai-completions-compatible does not support custom tool input",
    path: ["customToolInput"],
  },
);

/** An anthropic-compatible model entry: richer preset knobs forwarded via extra_body. */
const anthropicModelSchema = z
  .strictObject({
    ...modelMetadataSchema.shape,
    presets: z.record(z.string(), anthropicPresetSchema).optional(),
  })
  .superRefine((model, ctx) => addCapacityIssues(model, (issue) => ctx.addIssue(issue)))
  .refine((scope) => !scope.customToolInput?.supported, {
    message: "anthropic-compatible does not support custom tool input",
    path: ["customToolInput"],
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
/** One model entry in a completions-compatible custom provider (function-only input). */
export type CustomCompletionsModelConfig = z.infer<typeof completionsModelSchema>;
/** One model entry in an anthropic-compatible custom provider. */
export type CustomAnthropicModelConfig = z.infer<typeof anthropicModelSchema>;
/** Sampling knobs an OpenAI-compatible preset maps onto the Responses request. */
export type OpenAIPreset = z.infer<typeof openaiPresetSchema>;
/** Sampling knobs an Anthropic-compatible preset maps onto the Messages request. */
export type AnthropicPreset = z.infer<typeof anthropicPresetSchema>;
