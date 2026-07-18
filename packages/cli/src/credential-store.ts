import {
  FileSecretStore,
  KeyringSecretStore,
  MemorySecretStore,
  defaultCredentialsPath,
  type SecretStore,
} from "@harness/secrets";
import { getAuthStore, type AuthStoreKind } from "@harness/config";

/** Probe key: a healthy keyring returns null for a missing key; an unreachable one throws. */
const PROBE_KEY = "__harness_probe__";

/** One-shot check: can this machine reach an OS keyring at all? */
async function probeKeyring(): Promise<AuthStoreKind> {
  try {
    await new KeyringSecretStore().get(PROBE_KEY);
    return "keyring";
  } catch (cause) {
    if (process.platform === "win32") {
      throw new Error("Windows Credential Manager is unavailable", { cause });
    }
    return "file";
  }
}

const storeFor = (kind: AuthStoreKind): SecretStore =>
  kind === "keyring" ? new KeyringSecretStore() : new FileSecretStore(defaultCredentialsPath());

/**
 * Credential store for read paths (launch, status, logout). Unset `auth.store` means nothing was
 * ever stored, so reads see only env vars (an empty store). We never probe or silently fall back:
 * a set backend that can't be reached surfaces an error instead of switching.
 */
export async function credentialStoreForRead(
  home: string,
): Promise<{ store: SecretStore; kind: AuthStoreKind | null }> {
  const kind = await getAuthStore(home);
  if (!kind) return { store: new MemorySecretStore(), kind: null };
  return { store: storeFor(kind), kind };
}

/**
 * Credential store for `auth login`: picks a backend (override > persisted > one-time keyring
 * probe) before the first write. The caller persists the returned `kind` on success. `probe` is
 * injectable for tests.
 */
export async function credentialStoreForLogin(
  home: string,
  override?: AuthStoreKind,
  probe: () => Promise<AuthStoreKind> = probeKeyring,
): Promise<{ store: SecretStore; kind: AuthStoreKind }> {
  const kind = override ?? (await getAuthStore(home)) ?? (await probe());
  return { store: storeFor(kind), kind };
}
