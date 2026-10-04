import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { MemorySecretStore } from "@harness/secrets";
import { CodexAuth } from "./auth.ts";
import { CODEX_CLIENT_ID, loginWithDeviceCode } from "./oauth.ts";

afterEach(() => vi.restoreAllMocks());

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
function jwt(value: unknown): string {
  return `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
}
const accessToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "device-account" },
});
const tokens = {
  access_token: accessToken,
  refresh_token: "device-refresh",
  id_token: jwt({ email: "device@example.com" }),
  expires_in: 3600,
};
const device = { device_auth_id: "device-id", user_code: "TEST-CODE", interval: "1" };

it("completes pending device authorization and persists a normal reusable OAuth session", async () => {
  const store = new MemorySecretStore();
  let polls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input as string;
    if (url.endsWith("/deviceauth/usercode")) {
      expect(JSON.parse(init!.body as string)).toEqual({ client_id: CODEX_CLIENT_ID });
      return json(device);
    }
    if (url.endsWith("/deviceauth/token")) {
      expect(JSON.parse(init!.body as string)).toEqual({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
      });
      polls++;
      if (polls <= 2) return new Response(null, { status: polls === 1 ? 403 : 404 });
      return json({ authorization_code: "grant", code_verifier: "verifier" });
    }
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "grant",
      code_verifier: "verifier",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
    return json(tokens);
  };
  const auth = new CodexAuth({ store, fetch, now: () => 1000 });
  const prompt = vi.fn();
  expect(await auth.loginWithDeviceCode({ onUrl: prompt })).toMatchObject({
    accountId: "device-account",
    refreshToken: "device-refresh",
    expiresAt: 3601000,
  });
  expect(prompt).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "TEST-CODE");
  const reloaded = new CodexAuth({ store, now: () => 1000 });
  expect(await reloaded.status()).toMatchObject({
    authenticated: true,
    email: "device@example.com",
  });
  expect((await reloaded.getValidSession()).accessToken).toBe(accessToken);
  expect(await reloaded.logout()).toBe(true);
});

it("cancels an in-flight device poll, preserves existing credentials and allows a new login", async () => {
  const store = new MemorySecretStore();
  const original = JSON.stringify({
    accessToken,
    refreshToken: "old",
    idToken: tokens.id_token,
    accountId: "device-account",
    expiresAt: 10000000,
  });
  await store.set("oauth", original);
  let entered!: () => void;
  const polling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const abort = new AbortController();
  let hanging = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if ((input as string).endsWith("/usercode")) return json(device);
    if ((input as string).endsWith("/deviceauth/token")) {
      if (!hanging) return json({ authorization_code: "grant", code_verifier: "verifier" });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason as Error), {
          once: true,
        });
        entered();
      });
    }
    return json(tokens);
  };
  const auth = new CodexAuth({ store, fetch, now: () => 0 });
  const login = auth.loginWithDeviceCode({ signal: abort.signal });
  const outcome = expect(login).rejects.toMatchObject({ name: "AbortError" });
  await polling;
  await expect(auth.loginWithBrowser()).rejects.toThrow("already in progress");
  abort.abort();
  await outcome;
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  expect(await store.get("oauth")).toBe(original);
  hanging = false;
  expect(await auth.loginWithDeviceCode()).toMatchObject({ refreshToken: "device-refresh" });
});

it("cancels polling delay without sending another authorization request", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let polls = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    if ((input as string).endsWith("/usercode")) return json({ ...device, interval: "900" });
    polls++;
    entered();
    return new Response(null, { status: 403 });
  };
  const result = loginWithDeviceCode({ fetch, now: () => 0, signal: abort.signal });
  const cancelled = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await pending;
  abort.abort();
  await cancelled;
  expect(polls).toBe(1);
});

it("expires device authorization without writing credentials", async () => {
  const expiry = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 15 * 60000 ? expiry.signal : timeout(ms),
  );
  const store = new MemorySecretStore();
  const fetch: typeof globalThis.fetch = async () => json(device);
  const auth = new CodexAuth({ store, fetch });
  await expect(
    auth.loginWithDeviceCode({
      onUrl: () => expiry.abort(new DOMException("Expired", "TimeoutError")),
    }),
  ).rejects.toMatchObject({
    name: "ProviderSignInError",
    message: "Device-code sign-in expired; start again.",
  });
  expect(await store.get("oauth")).toBeNull();
});

it.each([400, 401, 429, 500])(
  "reports deterministic device failure %i without retrying",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("private response", { status }));
    await expect(loginWithDeviceCode({ fetch, now: () => 0 })).rejects.toThrow(`(${status})`);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("explains disabled device sign-in and validates provider codes before showing them", async () => {
  const unavailable: typeof globalThis.fetch = async () => new Response(null, { status: 404 });
  await expect(loginWithDeviceCode({ fetch: unavailable, now: () => 0 })).rejects.toThrow(
    "Enable device-code authentication",
  );
  const prompt = vi.fn();
  const invalid: typeof globalThis.fetch = async () => json({ ...device, interval: "oops" });
  await expect(
    loginWithDeviceCode({ fetch: invalid, now: () => 0, onUrl: prompt }),
  ).rejects.toThrow();
  expect(prompt).not.toHaveBeenCalled();
});
