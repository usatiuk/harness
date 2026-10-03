import {
  DpapiSecretStore,
  FileSecretStore,
  KeyringSecretStore,
  MemorySecretStore,
  defaultCredentialsPath,
  type SecretStore,
} from "@harness/secrets";
import { getAuthStore, type AuthStoreKind } from "@harness/config";

/** Probe key: a healthy keyring returns null for a missing key; an unreachable one throws. */
const PROBE_KEY = "__harness_probe__";

/** One-shot check: can this platform reach its native credential backend? */
async function probeNativeStore(): Promise<AuthStoreKind> {
  if (process.platform === "win32") {
    try {
      await DpapiSecretStore.probe();
      return "dpapi";
    } catch (cause) {
      throw new Error("Windows DPAPI is unavailable", { cause });
    }
  }

  try {
    await new KeyringSecretStore().get(PROBE_KEY);
    return "keyring";
  } catch {
    return "file";
  }
}

function storeFor(kind: AuthStoreKind): SecretStore {
  if (process.platform === "win32") {
    if (kind !== "dpapi") {
      throw new Error(`credential backend "${kind}" is unsupported on Windows; use DPAPI`);
    }
    return new DpapiSecretStore();
  }

  if (kind === "dpapi") {
    throw new Error("DPAPI credential storage is supported only on Windows");
  }
  return kind === "keyring"
    ? new KeyringSecretStore()
    : new FileSecretStore(defaultCredentialsPath());
}

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
 * Credential store for `auth login`: picks a backend (override > persisted > one-time native
 * probe) before the first write. The caller persists the returned `kind` on success. `probe` is
 * injectable for tests.
 */
export async function credentialStoreForLogin(
  home: string,
  override?: AuthStoreKind,
  probe: () => Promise<AuthStoreKind> = probeNativeStore,
): Promise<{ store: SecretStore; kind: AuthStoreKind }> {
  const kind = override ?? (await getAuthStore(home)) ?? (await probe());
  return { store: storeFor(kind), kind };
}
