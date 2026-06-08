import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "@harness/secrets";
import { CodexAuth } from "./auth.ts";
import { parseCodexSession, type CodexSession } from "./session.ts";

const STORE_KEY = "openai-codex";

function jwt(payload: Record<string, unknown>): string {
  const part = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

const accountToken = (id: string): string =>
  jwt({ "https://api.openai.com/auth": { chatgpt_account_id: id } });

function seedSession(
  store: MemorySecretStore,
  overrides: Partial<CodexSession> = {},
): Promise<void> {
  const session: CodexSession = {
    accessToken: accountToken("acc_1"),
    refreshToken: "refresh_1",
    idToken: jwt({ email: "a@b.com" }),
    accountId: "acc_1",
    expiresAt: 10_000,
    ...overrides,
  };
  return store.set(STORE_KEY, JSON.stringify(session));
}

/** A fetch that returns a fresh token bundle and records how many times it was called. */
function refreshingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        access_token: accountToken("acc_1"),
        refresh_token: "refresh_2",
        id_token: jwt({ email: "a@b.com" }),
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

describe("CodexAuth", () => {
  it("reports not-authenticated with an empty store", async () => {
    const auth = new CodexAuth({ store: new MemorySecretStore() });
    expect(await auth.status()).toEqual({ authenticated: false });
  });

  it("getValidSession throws when not signed in", async () => {
    const auth = new CodexAuth({ store: new MemorySecretStore() });
    await expect(auth.getValidSession()).rejects.toThrow(/Run `harness auth login`/u);
  });

  it("returns a still-valid session without hitting the network", async () => {
    const store = new MemorySecretStore();
    await seedSession(store, { expiresAt: 10 * 60 * 1000 });
    const fail = (async () => {
      throw new Error("should not refresh");
    }) as typeof fetch;
    const auth = new CodexAuth({ store, fetch: fail, now: () => 0 });
    const session = await auth.getValidSession();
    expect(session.refreshToken).toBe("refresh_1");
  });

  it("refreshes within the skew window and persists the new tokens", async () => {
    const store = new MemorySecretStore();
    await seedSession(store, { refreshToken: "refresh_1", expiresAt: 60 * 1000 });
    const net = refreshingFetch();
    // now=0, expiry=60s, skew=5min ⇒ due for refresh.
    const auth = new CodexAuth({ store, fetch: net.fetch, now: () => 0 });

    const session = await auth.getValidSession();
    expect(net.calls()).toBe(1);
    expect(session.refreshToken).toBe("refresh_2");
    expect(session.expiresAt).toBe(3600 * 1000);

    // Persisted: a fresh manager over the same store sees the rotated refresh token.
    const persisted = parseCodexSession((await store.get(STORE_KEY)) ?? "");
    expect(persisted.refreshToken).toBe("refresh_2");
  });

  it("logout clears the stored session", async () => {
    const store = new MemorySecretStore();
    await seedSession(store);
    const auth = new CodexAuth({ store });
    expect(await auth.logout()).toBe(true);
    expect(await store.get(STORE_KEY)).toBeNull();
    expect((await auth.status()).authenticated).toBe(false);
  });
});
