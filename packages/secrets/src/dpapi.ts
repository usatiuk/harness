import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretStore } from "./store.ts";
import { mutateCredentialFile } from "./file-mutation.ts";

const WINDOWS_PLATFORM = "win32";
const APP_DIRECTORY = "Harness";
const CREDENTIALS_FILE = "credentials.dpapi";
const SCOPE = "CurrentUser" as const;
let temporaryFileCounter = 0;

async function loadBindings() {
  const { Dpapi, isPlatformSupported } = await import("@primno/dpapi");
  if (!isPlatformSupported) {
    throw new Error(`the native DPAPI addon is unavailable on Windows ${process.arch}`);
  }
  return Dpapi;
}

function assertWindows(): void {
  if (process.platform !== WINDOWS_PLATFORM) {
    throw new Error("DPAPI credential storage is supported only on Windows");
  }
}

/** The default encrypted credential file under the current user's local application data. */
export function defaultDpapiCredentialsPath(): string {
  assertWindows();
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set; cannot locate Windows credential storage");
  }
  return join(localAppData, APP_DIRECTORY, CREDENTIALS_FILE);
}

/**
 * Windows `SecretStore` backed by a DPAPI-protected file. DPAPI owns key management and binds the
 * ciphertext to the current Windows user; the file is only a durable container for encrypted bytes.
 */
export class DpapiSecretStore implements SecretStore {
  readonly #path: string;

  constructor(path?: string) {
    if (path === undefined) {
      this.#path = defaultDpapiCredentialsPath();
    } else {
      assertWindows();
      this.#path = path;
    }
  }

  /** Verifies that native current-user protection works without creating a credential file. */
  static async probe(): Promise<void> {
    assertWindows();
    const api = await loadBindings();
    const input = Buffer.from("harness-dpapi-probe", "utf8");
    const encrypted = api.protectData(input, null, SCOPE);
    const decrypted = api.unprotectData(encrypted, null, SCOPE);
    if (!Buffer.from(decrypted).equals(input)) {
      throw new Error("DPAPI probe did not round-trip");
    }
  }

  async get(key: string): Promise<string | null> {
    return (await this.#read())[key] ?? null;
  }

  // Serialize same-process mutations across instances. Separate processes still
  // require external ownership of this file.
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
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`could not read Windows credentials at ${this.#path}`, { cause: error });
    }

    const api = await loadBindings();
    let decrypted: Uint8Array;
    try {
      decrypted = api.unprotectData(encrypted, null, SCOPE);
    } catch (cause) {
      throw new Error(`could not decrypt Windows credentials at ${this.#path}`, { cause });
    }
    try {
      return parseCredentialMap(Buffer.from(decrypted).toString("utf8"));
    } catch (cause) {
      throw new Error(`Windows credential file at ${this.#path} is corrupt`, { cause });
    }
  }

  async #write(data: Record<string, string>): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(data), "utf8");
    const api = await loadBindings();
    let encrypted: Uint8Array;
    try {
      encrypted = api.protectData(plaintext, null, SCOPE);
    } catch (cause) {
      throw new Error("could not protect Windows credentials with DPAPI", { cause });
    }

    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.${temporaryFileCounter++}.tmp`;
    try {
      await writeFile(tmp, encrypted);
      await rename(tmp, this.#path);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

function parseCredentialMap(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decrypted Windows credentials are not a credential map");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("decrypted Windows credentials contain a non-string value");
  }
  return Object.fromEntries(entries);
}
