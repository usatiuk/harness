import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  decodeAccountId,
  decodeEmail,
  exchangeCode,
  refreshTokens,
} from "./oauth.ts";

/** Builds an unsigned JWT (`header.payload.sig`) carrying `payload`. */
function jwt(payload: Record<string, unknown>): string {
  const part = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

const accessToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" } });
const idToken = jwt({ email: "user@example.com" });

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "refresh_xyz",
      id_token: idToken,
      expires_in: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("buildAuthorizeUrl", () => {
  it("includes the Codex-specific PKCE and flow params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("originator")).toBe("harness");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization_code grant and normalizes the token response", async () => {
    let seen: { url: string; body: string } | undefined;
    const fakeFetch = (async (url, init) => {
      seen = { url: url as string, body: (init?.body as URLSearchParams).toString() };
      return tokenResponse();
    }) as typeof fetch;

    const tokens = await exchangeCode({
      code: "the-code",
      verifier: "the-verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      fetch: fakeFetch,
      now: () => 1_000,
    });

    expect(seen?.url).toBe("https://auth.openai.com/oauth/token");
    expect(seen?.body).toContain("grant_type=authorization_code");
    expect(seen?.body).toContain("code=the-code");
    expect(seen?.body).toContain("code_verifier=the-verifier");
    expect(tokens.accessToken).toBe(accessToken);
    expect(tokens.refreshToken).toBe("refresh_xyz");
    expect(tokens.expiresAt).toBe(1_000 + 3600 * 1000);
  });

  it("throws a redacted error on a non-2xx response", async () => {
    const fakeFetch = (async () =>
      new Response("error: code=secretvalue", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode({ code: "c", verifier: "v", redirectUri: "r", fetch: fakeFetch }),
    ).rejects.toThrow(/code=<redacted>/u);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh_token grant", async () => {
    let body: string | undefined;
    const fakeFetch = (async (_url, init) => {
      body = (init?.body as URLSearchParams).toString();
      return tokenResponse();
    }) as typeof fetch;
    const tokens = await refreshTokens({
      refreshToken: "old-refresh",
      fetch: fakeFetch,
      now: () => 0,
    });
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
    expect(tokens.accessToken).toBe(accessToken);
  });
});

describe("decodeAccountId / decodeEmail", () => {
  it("reads the account id from the access token claim", () => {
    expect(decodeAccountId(accessToken)).toBe("acc_123");
  });
  it("throws when the account id claim is missing", () => {
    expect(() => decodeAccountId(jwt({ sub: "x" }))).toThrow(/chatgpt_account_id/u);
  });
  it("reads the email from the id token, or undefined", () => {
    expect(decodeEmail(idToken)).toBe("user@example.com");
    expect(decodeEmail(jwt({ sub: "x" }))).toBeUndefined();
  });
});
