import { createConnection, Socket } from "node:net";
import { getEventListeners } from "node:events";
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

interface BrowserCallback {
  socket: Socket;
  blocker: Socket;
  response: Promise<string>;
  closed: Promise<boolean>;
  blockerClosed: Promise<boolean>;
}

/** Sends the OAuth redirect over a browser-style persistent HTTP connection. */
function openCallback(authorizeUrl: string): BrowserCallback {
  const authorize = new URL(authorizeUrl);
  const redirectValue = authorize.searchParams.get("redirect_uri");
  const state = authorize.searchParams.get("state");
  if (!redirectValue || !state) throw new Error("authorize URL is missing redirect state");

  const redirect = new URL(redirectValue);
  redirect.searchParams.set("state", state);
  redirect.searchParams.set("code", "authorization-code");

  const socket = new Socket();
  socket.setTimeout(3_000, () => {
    socket.destroy(new Error("OAuth callback server did not close the browser connection"));
  });
  const blocker = createConnection(Number(redirect.port), "127.0.0.1");
  let blockerTimedOut = false;
  blocker.setTimeout(3_000, () => {
    blockerTimedOut = true;
    blocker.destroy();
  });
  blocker.on("error", () => {});
  const blockerClosed = new Promise<boolean>((resolve) => {
    blocker.once("close", () => resolve(!blockerTimedOut));
  });

  const response = new Promise<string>((resolve, reject) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.includes("Signed in to Codex")) resolve(raw);
    });
    socket.once("error", reject);
  });
  const closed = new Promise<boolean>((resolve) => {
    socket.once("close", (hadError) => {
      resolve(hadError);
    });
  });

  blocker.once("connect", () => {
    // Model a second browser connection that remains active without completing its request.
    blocker.write(`GET /favicon.ico HTTP/1.1\r\nHost: ${redirect.host}\r\n`);
    socket.connect(Number(redirect.port), "127.0.0.1", () => {
      socket.write(
        [
          `GET ${redirect.pathname}${redirect.search} HTTP/1.1`,
          `Host: ${redirect.host}`,
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
  return { socket, blocker, response, closed, blockerClosed };
}

describe("CodexAuth", () => {
  it("does not cache a credential read that completes after logout", async () => {
    const store = new MemorySecretStore();
    await seedSession(store);
    const get = store.get.bind(store);
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    store.get = async (key) => {
      const value = await get(key);
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return value;
    };
    const auth = new CodexAuth({ store, now: () => 0 });
    const reading = auth.getValidSession();
    const rejected = expect(reading).rejects.toThrow("authentication changed");
    await began;
    await auth.logout();
    release();
    await rejected;
    expect(await auth.status()).toEqual({ authenticated: false });
    await expect(auth.getValidSession()).rejects.toThrow("Not signed in");
    expect(await get(STORE_KEY)).toBeNull();
  });

  it("cancels a stalled token rotation when signing out", async () => {
    const store = new MemorySecretStore();
    await seedSession(store);
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const auth = new CodexAuth({
      store,
      now: () => 0,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Refresh omitted cancellation");
        entered();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        });
      },
    });
    const refresh = auth.getValidSession();
    const rejected = expect(refresh).rejects.toThrow("authentication changed");
    await began;
    await auth.logout();
    await rejected;
    expect(await auth.status()).toEqual({ authenticated: false });
  });
  it("keeps independently named OAuth accounts and rotated token records isolated", async () => {
    const store = new MemorySecretStore();
    await seedSession(store);
    const original = await store.get(STORE_KEY);
    if (!original) throw new Error("Missing seed");
    await store.set("work-oauth", original);
    await store.set(
      "personal-oauth",
      JSON.stringify({
        ...parseCodexSession(original),
        accountId: "personal",
        expiresAt: 1_000_000,
      }),
    );
    const net = refreshingFetch();
    const work = new CodexAuth({ store, storeKey: "work-oauth", fetch: net.fetch, now: () => 0 });
    const personal = new CodexAuth({ store, storeKey: "personal-oauth", now: () => 0 });
    await Promise.all([work.getValidSession(), work.getValidSession()]);
    expect(net.calls()).toBe(1);
    expect((await personal.getValidSession()).accountId).toBe("personal");
    expect(parseCodexSession((await store.get("work-oauth"))!).refreshToken).toBe("refresh_2");
    expect(parseCodexSession((await store.get("personal-oauth"))!).refreshToken).toBe("refresh_1");
    await work.logout();
    expect(await work.status()).toEqual({ authenticated: false });
    expect((await personal.status()).authenticated).toBe(true);
    expect(await store.get(STORE_KEY)).toBe(original);
  });

  it("does not resurrect an OAuth session when logout races with token rotation", async () => {
    const store = new MemorySecretStore();
    await seedSession(store);
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const net = refreshingFetch();
    const auth = new CodexAuth({
      store,
      now: () => 0,
      fetch: async (...args) => {
        started();
        await released;
        return net.fetch(...args);
      },
    });
    const refresh = auth.getValidSession();
    const failed = expect(refresh).rejects.toThrow("authentication changed");
    await began;
    const logout = auth.logout();
    release();
    await Promise.all([failed, logout]);
    expect(await store.get(STORE_KEY)).toBeNull();
    expect(await auth.status()).toEqual({ authenticated: false });
  });
  it("cancels browser sign-in even when the URL callback aborts before listener registration", async () => {
    const store = new MemorySecretStore();
    const auth = new CodexAuth({ store, openBrowser: false });
    const controller = new AbortController();
    let redirect: string | undefined;
    await expect(
      auth.loginWithBrowser({
        signal: controller.signal,
        onUrl: (url) => {
          redirect = new URL(url).searchParams.get("redirect_uri") ?? undefined;
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await store.get(STORE_KEY)).toBeNull();
    if (!redirect) throw new Error("OAuth flow did not publish a redirect");
    await expect(fetch(redirect)).rejects.toThrow();
  });
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

  it("completes browser login and closes a persistent callback connection", async () => {
    const store = new MemorySecretStore();
    const net = refreshingFetch();
    const auth = new CodexAuth({
      store,
      fetch: net.fetch,
      now: () => 0,
      openBrowser: false,
    });
    let callback: BrowserCallback | undefined;

    try {
      const session = await auth.loginWithBrowser({
        onUrl: (url) => {
          callback = openCallback(url);
        },
      });
      if (!callback) throw new Error("login did not publish an authorize URL");

      const response = await callback.response;
      expect(await callback.closed).toBe(false);
      expect(await callback.blockerClosed).toBe(true);
      expect(response).toMatch(/\r\nconnection: close\r\n/iu);
      expect(session.accountId).toBe("acc_1");
      expect((await store.get(STORE_KEY)) ?? "").toContain("refresh_2");
    } finally {
      callback?.socket.destroy();
      callback?.blocker.destroy();
    }
  });
});
