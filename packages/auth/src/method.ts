/**
 * The generic sign-in seam every provider implements. A discriminated union: an API-key method
 * holds a static secret, an OAuth method runs a browser flow — so invalid states (a browser flow
 * on an API-key method, a key on an OAuth method) can't be represented.
 */
export interface AuthStatus {
  authenticated: boolean;
  /** For API keys: whether the active key came from the environment or stored credentials. */
  source?: "env" | "stored";
  /** Human-readable detail: an account email, `$ENV_VAR`, etc. */
  detail?: string;
  /** Epoch ms the credential expires (OAuth tokens). */
  expiresAt?: number;
}

interface CommonAuth {
  readonly id: string;
  readonly label: string;
  status(): Promise<AuthStatus>;
  /** Removes stored credentials. True if something was removed. */
  logout(): Promise<boolean>;
}

export interface ApiKeyMethod extends CommonAuth {
  readonly kind: "api-key";
  /** The environment variable that overrides the stored key, cited in status/help. */
  readonly envVar: string;
  /** Returns an error message for a malformed key, or null when it looks valid. */
  validate(key: string): string | null;
  /** Validates and persists a key. Throws if validation fails. */
  submit(key: string): Promise<void>;
  /** The key to use at runtime: the environment variable wins over the stored value. */
  getKey(): Promise<string | null>;
}

export interface OAuthMethod extends CommonAuth {
  readonly kind: "oauth";
  /** Runs the interactive browser flow. `onUrl` receives the authorize URL for a manual fallback. */
  login(opts: { onUrl: (url: string) => void; signal?: AbortSignal }): Promise<void>;
}

export type AuthMethod = ApiKeyMethod | OAuthMethod;
