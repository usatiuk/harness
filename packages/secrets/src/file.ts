import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretStore } from "./store.ts";
import { mutateCredentialFile } from "./file-mutation.ts";

/** The default credentials file: `~/.harness/credentials.json`. */
export const defaultCredentialsPath = (): string => join(homedir(), ".harness", "credentials.json");

/**
 * `SecretStore` backed by a JSON file, used as a fallback when no OS keyring is available
 * (headless Linux, containers, CI). The file is written atomically at mode 0600 inside a
 * 0700 directory; only the owner can read the stored secrets.
 */
export class FileSecretStore implements SecretStore {
  readonly #path: string;

  constructor(path: string = defaultCredentialsPath()) {
    if (process.platform === "win32") {
      throw new Error("plain file credential storage is unsupported on Windows; use DPAPI");
    }
    this.#path = path;
  }

  async get(key: string): Promise<string | null> {
    return (await this.#read())[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    return mutateCredentialFile(this.#path, async () => {
      const data = await this.#read();
      data[key] = value;
      await this.#write(data);
    });
  }

  async delete(key: string): Promise<boolean> {
    return mutateCredentialFile(this.#path, async () => {
      const data = await this.#read();
      if (!(key in data)) return false;
      delete data[key];
      await this.#write(data);
      return true;
    });
  }

  async #read(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  }

  async #write(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    // Atomic write: temp file + rename avoids partial reads; explicit chmod since umask masks the create mode.
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.#path);
  }
}
