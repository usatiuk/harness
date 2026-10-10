import { z } from "zod";
import { jsonValueSchema } from "@harness/protocol";

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
const toolsSchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  mode: z.enum(["direct", "hybrid", "code-only"]).optional(),
});

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
 * machine-global `auth` and `providers` keys, which only the global settings file accepts.
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
  providers: z
    .record(
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
      z.strictObject({
        type: z.string().min(1),
        label: z.string().trim().min(1).max(200).optional(),
        config: z.record(z.string(), jsonValueSchema).default({}),
      }),
    )
    .optional(),
});

export type SettingsDoc = z.infer<typeof settingsDocSchema>;
export const SETTINGS_FILE_VERSION = 1;
const fileVersionSchema = z.object({ version: z.literal(SETTINGS_FILE_VERSION) }).passthrough();

/** Only persisted files carry a version; profiles and RPC fragments do not. */
export function decodeSettingsFile(raw: unknown, path: string): Record<string, unknown> {
  const parsed = fileVersionSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Unsupported Harness settings format in ${path}; this client supports version ${SETTINGS_FILE_VERSION}. Upgrade Harness or explicitly replace this pre-release file; it was not changed.`,
    );
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key !== "version"));
}

export function encodeSettingsFile(document: SettingsDoc) {
  return { version: SETTINGS_FILE_VERSION, ...document };
}

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
 * `settings.local.json`), which rejects the global-only `auth`/`providers`
 * keys. Shares the error format with `parseSettingsDoc` so all layers read the
 * same way.
 */
export function parseProjectDoc(raw: unknown, path: string): SettingsDoc {
  const parsed = projectDocSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid settings in ${path}: ${formatIssue(parsed.error)}`);
  return parsed.data;
}
