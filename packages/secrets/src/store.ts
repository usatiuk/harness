/**
 * A namespace of string secrets keyed by an opaque string. The OS keyring backs it in
 * production; an in-memory map backs it in tests. `get` yields null when a key is absent.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** True if a secret was removed, false if the key held nothing. */
  delete(key: string): Promise<boolean>;
}
