import { describe, expect, test } from "vitest";
import {
  KeyringOpenAIAuthStore,
  OPENAI_CHATGPT_AUTH_KIND,
  OpenAIChatGptAuthManager,
  type OpenAIChatGptSession,
  type SecretEntry,
  type SecretEntryFactory
} from "@harness/auth-openai";

describe("OpenAI ChatGPT auth", () => {
  test("stores the active ChatGPT session in keyring", async () => {
    const keyring = new MemoryKeyring();
    const store = new KeyringOpenAIAuthStore({ harnessHome: "/tmp/harness-test", keyring });
    const session = chatGptSession();

    await store.saveActive(session);

    expect(await store.loadActive()).toEqual(session);
    expect(await store.deleteActive()).toBe(true);
    expect(await store.loadActive()).toBeUndefined();
  });

  test("refreshes expired OAuth sessions and persists the replacement", async () => {
    let saved: OpenAIChatGptSession | undefined = chatGptSession({ expiresAt: 1 });
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const manager = new OpenAIChatGptAuthManager({
      harnessHome: "/tmp/harness-test",
      now: () => 1_000_000,
      store: {
        loadActive: async () => saved,
        saveActive: async (session) => {
          saved = session;
        },
        deleteActive: async () => true
      },
      fetch: (async (url, init) => {
        fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
        return jsonResponse({
          id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-refreshed", chatgpt_plan_type: "pro" } }),
          access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-refreshed" }, exp: 2_000 }),
          refresh_token: "refresh-new",
          expires_in: 3600
        });
      }) as typeof fetch
    });

    const session = await manager.getValidSession();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(fetchCalls[0]?.body).toContain("grant_type=refresh_token");
    expect(session.accountId).toBe("account-refreshed");
    expect(session.planType).toBe("pro");
    expect(saved?.refreshToken).toBe("refresh-new");
  });

  test("reports missing active auth without touching keyring secrets", async () => {
    const manager = new OpenAIChatGptAuthManager({
      harnessHome: "/tmp/harness-test",
      store: {
        loadActive: async () => undefined,
        saveActive: async () => undefined,
        deleteActive: async () => false
      }
    });

    await expect(manager.getValidSession()).rejects.toThrow("ChatGPT login required");
    await expect(manager.status()).resolves.toEqual({ authenticated: false, storage: "keyring" });
  });
});

class MemoryKeyring implements SecretEntryFactory {
  private readonly values = new Map<string, string>();

  public entry(service: string, account: string): SecretEntry {
    const key = `${service}:${account}`;
    return {
      getPassword: () => this.values.get(key) ?? null,
      setPassword: (password) => {
        this.values.set(key, password);
      },
      deletePassword: () => this.values.delete(key)
    };
  }
}

function chatGptSession(overrides: Partial<OpenAIChatGptSession> = {}): OpenAIChatGptSession {
  return {
    version: 1,
    kind: OPENAI_CHATGPT_AUTH_KIND,
    issuer: "https://auth.openai.com",
    accountId: "account-1",
    accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }, exp: 2_000 }),
    refreshToken: "refresh-1",
    idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }, email: "user@example.com" }),
    expiresAt: 2_000_000,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...overrides
  };
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
