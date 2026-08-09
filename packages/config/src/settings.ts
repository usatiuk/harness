import { z } from "zod";
import { FILE_TOOLS } from "@harness/protocol";

/**
 * The on-disk settings document — kernel keys plus an opaque per-plugin namespace
 * and named profiles. Strict: an unknown top-level key (a typo) is rejected. Plugin
 * slices are opaque here and validated later against each plugin's own schema.
 */
const modelSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  preset: z.string().optional(),
});
const toolsSchema = z.strictObject({ allow: z.array(z.string()).optional() });

/** Generation parameters an OpenAI-compatible preset maps to an SDK call. */
const openaiPresetSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  /** Freeform fields merged into the request body (e.g. `seed`, `top_k`). */
  extraBody: z.record(z.string(), z.unknown()).optional(),
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
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Fields shared by every custom provider entry. `fileTools` defaults are applied
 * per type: `string_replace` for the OpenAI families, `text_editor` for Anthropic.
 */
const customProviderBase = z.object({
  /** Custom endpoint. OpenAI-compatible: include the API root (e.g. `http://host:8000/v1`).
   * Anthropic-compatible: the server root (the SDK appends the Messages path). */
  endpoint: z.string().url(),
  /** API key the endpoint expects; required so the SDK never guesses, even for keyless local servers. */
  apiKey: z.string(),
  /** Model name on the endpoint. */
  model: z.string(),
  /** Model context window in tokens; capacity math (auto-compaction) applies when set. */
  contextWindow: z.number().int().positive().optional(),
  /** Model max output in tokens; reserved when estimating whether the next input fits. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** The file-editing dialect the model is trained on; the workspace plugin selects its tool roster
   * from it. Absent defaults to `string_replace` for the OpenAI-compatible families and
   * `text_editor` for anthropic-compatible. */
  fileTools: z.enum(FILE_TOOLS).optional(),
});

const customProviderSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...customProviderBase.shape,
    type: z.literal("openai-responses-compatible"),
    presets: z.record(z.string(), openaiPresetSchema).optional(),
    /**
     * Some OpenAI Responses-compatible backends (e.g. OVMS) accept the Responses request shape but
     * silently drop the top-level `instructions` field. When set, the provider renders
     * `ModelRequest.instructions` as a leading `system` input message instead, so those backends still
     * receive the system context.
     */
    sendInstructionsAsSystem: z.boolean().optional(),
  }),
  // Chat/completions is function-only: `apply_patch` (a freeform custom tool) cannot be represented,
  // so that dialect is rejected here rather than failing mid-turn.
  z
    .strictObject({
      ...customProviderBase.shape,
      type: z.literal("openai-completions-compatible"),
      presets: z.record(z.string(), openaiPresetSchema).optional(),
    })
    .refine((entry) => entry.fileTools !== "apply_patch", {
      message: "openai-completions-compatible supports only function tools (not 'apply_patch')",
      path: ["fileTools"],
    }),
  z.strictObject({
    ...customProviderBase.shape,
    type: z.literal("anthropic-compatible"),
    presets: z.record(z.string(), anthropicPresetSchema).optional(),
  }),
]);

export type CustomProviderConfig = z.infer<typeof customProviderSchema>;
/** Sampling knobs an OpenAI-compatible preset maps onto the Responses request. */
export type OpenAIPreset = z.infer<typeof openaiPresetSchema>;
/** Sampling knobs an Anthropic-compatible preset maps onto the Messages request. */
export type AnthropicPreset = z.infer<typeof anthropicPresetSchema>;

/** Which credential backend `auth login` chose for this machine; resolved once and pinned. */
export const AUTH_STORE_KINDS = ["keyring", "file", "dpapi"] as const;
const authSchema = z.strictObject({ store: z.enum(AUTH_STORE_KINDS) });
export type AuthStoreKind = (typeof AUTH_STORE_KINDS)[number];

const baseFields = {
  model: modelSchema.optional(),
  instructions: z.string().optional(),
  tools: toolsSchema.optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
};

/** A profile is a settings fragment without nested profiles. */
export const profileDocSchema = z.strictObject(baseFields);

/**
 * The project- and local-layer settings doc (`.harness/settings.json` and
 * `.harness/settings.local.json`): the kernel keys plus named profiles, but NOT the
 * machine-global `auth` and `customProviders` keys, which only the global settings file accepts.
 * Rejecting them here makes a stray project-local occurrence a loud error instead of a silently
 * dropped one — the CLI reads those keys only from the global file.
 */
export const projectDocSchema = z.strictObject({
  ...baseFields,
  profiles: z.record(z.string(), profileDocSchema).optional(),
});

export const settingsDocSchema = z.strictObject({
  ...projectDocSchema.shape,
  auth: authSchema.optional(),
  customProviders: z.record(z.string(), customProviderSchema).optional(),
});

export type SettingsDoc = z.infer<typeof settingsDocSchema>;

/** First validation issue as `path: message`, for human-readable config errors. */
export function formatIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parses a global settings document, throwing a human-readable error citing the
 * source file on failure. Centralized so the settings resolver and the CLI's
 * global read/write paths share the same message format.
 */
export function parseSettingsDoc(raw: unknown, path: string): SettingsDoc {
  const parsed = settingsDocSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid settings in ${path}: ${formatIssue(parsed.error)}`);
  return parsed.data;
}

/**
 * Parses one project-layer settings document (`.harness/settings.json` and
 * `settings.local.json`), which rejects the global-only `auth`/`customProviders`
 * keys. Shares the error format with `parseSettingsDoc` so all layers read the
 * same way.
 */
export function parseProjectDoc(raw: unknown, path: string): SettingsDoc {
  const parsed = projectDocSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid settings in ${path}: ${formatIssue(parsed.error)}`);
  return parsed.data;
}
