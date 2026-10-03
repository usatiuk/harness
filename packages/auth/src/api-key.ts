import type { ProviderSecrets } from "@harness/protocol";
import type { ApiKeyMethod, AuthStatus } from "./method.ts";

export interface ApiKeyAuthOptions {
  id: string;
  label: string;
  store: ProviderSecrets;
  /** Environment variable that overrides the stored key. */
  envVar?: string;
  allowStored?: boolean;
  /** Optional shape check returning an error message, or null when the key looks valid. */
  validate?: (key: string) => string | null;
}

/**
 * Generic API-key sign-in over instance-scoped secrets. The env var wins over the stored key (so CI and
 * one-off overrides keep working); `auth login` persists a key for everyone who doesn't set it.
 */
export class ApiKeyAuth implements ApiKeyMethod {
  readonly kind = "api-key" as const;
  readonly id: string;
  readonly label: string;
  readonly envVar?: string;
  readonly canStore: boolean;
  readonly #store: ProviderSecrets;
  readonly #validate: (key: string) => string | null;

  constructor(opts: ApiKeyAuthOptions) {
    this.id = opts.id;
    this.label = opts.label;
    if (opts.envVar !== undefined) this.envVar = opts.envVar;
    this.canStore = opts.allowStored ?? true;
    this.#store = opts.store;
    this.#validate = opts.validate ?? (() => null);
  }

  validate(key: string): string | null {
    const trimmed = key.trim();
    if (trimmed === "") return "API key must not be empty";
    return this.#validate(trimmed);
  }

  async submit(key: string): Promise<void> {
    if (!this.canStore)
      throw new Error(`Credentials for '${this.id}' are managed by the environment`);
    const trimmed = key.trim();
    const error = this.validate(trimmed);
    if (error) throw new Error(error);
    await this.#store.set("api-key", trimmed);
  }

  async getKey(): Promise<string | null> {
    const fromEnv = this.envVar ? process.env[this.envVar]?.trim() : undefined;
    if (fromEnv) return fromEnv;
    return this.canStore ? this.#store.get("api-key") : null;
  }

  async status(): Promise<AuthStatus> {
    const fromEnv = this.envVar ? process.env[this.envVar]?.trim() : undefined;
    if (fromEnv) return { authenticated: true, source: "env", detail: `$${this.envVar}` };
    const stored = this.canStore ? await this.#store.get("api-key") : null;
    if (stored) return { authenticated: true, source: "stored", detail: "stored credential" };
    return { authenticated: false };
  }

  logout(): Promise<boolean> {
    if (!this.canStore)
      throw new Error(`Credentials for '${this.id}' are managed by the environment`);
    return this.#store.delete("api-key");
  }
}
