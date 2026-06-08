import type { SecretStore } from "./store.ts";

/** In-memory `SecretStore` for tests. */
export class MemorySecretStore implements SecretStore {
  readonly #entries = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#entries.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.#entries.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(key));
  }
}
