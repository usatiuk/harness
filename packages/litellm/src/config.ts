import { z } from "zod";
import { FILE_TOOLS } from "@harness/protocol";
import { apiKeySourceSchema } from "@harness/auth";

export const transportSchema = z.enum([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
export const modelIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0, "Model ID must not be blank");
const tokens = z.number().int().positive();
const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const thinking = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("adaptive"),
    display: z.enum(["summarized", "omitted"]).optional(),
  }),
  z.strictObject({ type: z.literal("disabled") }),
  z.strictObject({ type: z.literal("enabled"), budget_tokens: z.number().int().min(1024) }),
]);
const generation = {
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  requestMaxOutputTokens: tokens.optional(),
  reasoningEffort: effort.optional(),
  thinking: thinking.optional(),
};
export const modelProfileSchema = z.strictObject({
  codingCompatible: z.literal(true).optional(),
  transport: transportSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  fileTools: z.enum(FILE_TOOLS).optional(),
  contextWindow: tokens.optional(),
  maxOutputTokens: tokens.optional(),
  ...generation,
  reasoningSummary: z.enum(["auto", "concise", "detailed"]).optional(),
  presets: z.record(z.string().min(1).max(128), z.strictObject(generation)).optional(),
  defaultPreset: z.string().min(1).optional(),
  pricing: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cachedRead: z.number().nonnegative().optional(),
      cacheWrite: z.record(z.string().regex(/^[1-9][0-9]*$/), z.number().nonnegative()).optional(),
    })
    .optional(),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type Transport = z.infer<typeof transportSchema>;
export type Generation = Pick<ModelProfile, keyof typeof generation>;

/** Validate the resolved profile once; request builders then trust this boundary. */
export function validateProfile(profile: ModelProfile, transport: Transport): void {
  if (profile.fileTools === "apply_patch" && transport !== "openai-responses")
    throw new Error("apply_patch requires openai-responses");
  if (
    profile.maxOutputTokens !== undefined &&
    profile.contextWindow !== undefined &&
    profile.maxOutputTokens > profile.contextWindow
  )
    throw new Error("maxOutputTokens exceeds contextWindow");
  if (profile.defaultPreset && !Object.hasOwn(profile.presets ?? {}, profile.defaultPreset))
    throw new Error("defaultPreset must name an offered preset");
  if (profile.reasoningSummary && transport !== "openai-responses")
    throw new Error("reasoningSummary requires openai-responses");
  for (const controls of [profile, ...Object.values(profile.presets ?? {})]) {
    if (controls.thinking && transport !== "anthropic-messages")
      throw new Error("thinking requires anthropic-messages");
    if (
      transport === "anthropic-messages" &&
      controls.reasoningEffort &&
      ["none", "minimal"].includes(controls.reasoningEffort)
    )
      throw new Error("Messages effort must be low or higher");
    const cap = controls.requestMaxOutputTokens ?? profile.requestMaxOutputTokens;
    const hard = profile.maxOutputTokens ?? profile.contextWindow;
    if (cap !== undefined && hard !== undefined && cap > hard)
      throw new Error("requestMaxOutputTokens exceeds declared capacity");
    const selectedThinking = controls.thinking ?? profile.thinking;
    if (
      selectedThinking?.type === "enabled" &&
      selectedThinking.budget_tokens >=
        (cap ?? Math.min(8192, profile.maxOutputTokens ?? 8192, profile.contextWindow ?? 8192))
    )
      throw new Error("thinking budget must be below the output request cap");
  }
}

export const liteLLMConfigSchema = z
  .strictObject({
    baseUrl: z.url().superRefine((value, ctx) => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        ctx.addIssue({
          code: "custom",
          message: "baseUrl must be an HTTP(S) gateway root without credentials, query or fragment",
        });
    }),
    apiKey: apiKeySourceSchema.default({ stored: true }),
    defaultTransport: transportSchema.default("openai-completions"),
    models: z.record(modelIdSchema, modelProfileSchema).default({}),
  })
  .superRefine((config, ctx) => {
    if (Object.keys(config.models).length > 5000)
      ctx.addIssue({ code: "custom", path: ["models"], message: "at most 5000 configured models" });
    for (const [id, profile] of Object.entries(config.models)) {
      try {
        validateProfile(profile, profile.transport ?? config.defaultTransport);
      } catch (error) {
        ctx.addIssue({ code: "custom", path: ["models", id], message: (error as Error).message });
      }
    }
  });
export type LiteLLMConfig = z.infer<typeof liteLLMConfigSchema>;
