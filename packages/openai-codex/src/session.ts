import { z } from "zod";

/**
 * A persisted Codex OAuth session: the tokens plus the account id and expiry needed to use
 * and refresh them. Serialized as JSON into the secret store.
 */
export const codexSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  accountId: z.string(),
  /** Epoch ms at which the access token expires. */
  expiresAt: z.number(),
  email: z.string().optional(),
});

export type CodexSession = z.infer<typeof codexSessionSchema>;

/** Parses a stored session, throwing if the JSON is malformed or missing fields. */
export function parseCodexSession(raw: string): CodexSession {
  return codexSessionSchema.parse(JSON.parse(raw));
}
