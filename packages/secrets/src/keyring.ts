import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import type { SecretStore } from "./store.ts";

const DEFAULT_SERVICE = "Harness";

/**
 * `SecretStore` backed by the OS keyring (macOS Keychain / libsecret / Windows Credential
 * Manager) via `@napi-rs/keyring`. The native addon is imported lazily, so it loads only when
 * a secret is actually accessed rather than at every process start.
 */
export class KeyringSecretStore implements SecretStore {
  readonly #service: string;

  constructor(service: string = DEFAULT_SERVICE) {
    this.#service = service;
  }

  async get(key: string): Promise<string | null> {
    return (await this.#entry(key)).getPassword();
  }

  async set(key: string, value: string): Promise<void> {
    (await this.#entry(key)).setPassword(value);
  }

  async delete(key: string): Promise<boolean> {
    const entry = await this.#entry(key);
    // Probe absence explicitly so backend/access failures during deletion are never reported as
    // "nothing removed" by logout.
    if (entry.getPassword() === null) return false;
    return entry.deleteCredential();
  }

  async #entry(key: string): Promise<KeyringEntry> {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(this.#service, key);
  }
}
