import { describe, expect, test } from "vitest";
import {
    OPENAI_AUTH_ISSUER,
    OPENAI_CHATGPT_AUTH_KIND,
    OpenAIChatGptAuthManager,
    redactOpenAIAuthText,
    type OpenAIAuthStore,
    type OpenAIChatGptSession,
} from "../src/index.ts";

const AUTH_CLAIM = "https://api.openai.com/auth";
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("OpenAI ChatGPT auth manager", () => {
    test("reports unauthenticated status without touching network", async () => {
        const fetches: string[] = [];
        const manager = new OpenAIChatGptAuthManager({
            harnessHome: "/tmp/harness-auth-test",
            store: new MemoryAuthStore(),
            fetch: async (url) => {
                fetches.push(fetchInputUrl(url));
                return jsonResponse({});
            },
        });

        expect(await manager.status()).toEqual({
            authenticated: false,
            storage: "keyring",
        });
        expect(fetches).toEqual([]);
    }, 5000);

    test("refreshes expiring sessions and persists refreshed tokens", async () => {
        const store = new MemoryAuthStore(expiringSession());
        const manager = new OpenAIChatGptAuthManager({
            harnessHome: "/tmp/harness-auth-test",
            store,
            now: () => NOW,
            fetch: async (url, init) => {
                expect(fetchInputUrl(url)).toBe(
                    `${OPENAI_AUTH_ISSUER}/oauth/token`,
                );
                expect(fetchBodyText(init?.body)).toContain(
                    "grant_type=refresh_token",
                );
                return jsonResponse(
                    tokenResponse({ refreshToken: "refresh_after" }),
                );
            },
        });

        const refreshed = await manager.getValidSession();

        expect(refreshed.refreshToken).toBe("refresh_after");
        expect(store.session?.refreshToken).toBe("refresh_after");
        expect(store.session?.lastRefreshAt).toBe("2026-01-01T00:00:00.000Z");
    }, 5000);

    test("device login persists session after user-code authorization", async () => {
        const store = new MemoryAuthStore();
        const seen: string[] = [];
        const manager = new OpenAIChatGptAuthManager({
            harnessHome: "/tmp/harness-auth-test",
            store,
            now: () => NOW,
            fetch: async (url, init) => {
                const urlText = fetchInputUrl(url);
                seen.push(urlText);
                if (urlText.endsWith("/api/accounts/deviceauth/usercode")) {
                    return jsonResponse({
                        device_auth_id: "device_1",
                        user_code: "ABCD-EFGH",
                        interval: 0,
                    });
                }
                if (urlText.endsWith("/api/accounts/deviceauth/token")) {
                    return jsonResponse({
                        authorization_code: "auth_code",
                        code_verifier: "verifier",
                    });
                }
                if (urlText.endsWith("/oauth/token")) {
                    const body = fetchBodyText(init?.body);
                    expect(body).toContain("grant_type=authorization_code");
                    expect(body).toContain("code=auth_code");
                    return jsonResponse(
                        tokenResponse({ refreshToken: "refresh_device" }),
                    );
                }
                return jsonResponse({}, 404);
            },
        });
        let userCode = "";

        const session = await manager.loginWithDeviceCode({
            onDeviceCode: (info) => {
                userCode = info.userCode;
            },
        });

        expect(userCode).toBe("ABCD-EFGH");
        expect(session.accountId).toBe("acct_1");
        expect(store.session?.refreshToken).toBe("refresh_device");
        expect(seen).toEqual([
            `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`,
            `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`,
            `${OPENAI_AUTH_ISSUER}/oauth/token`,
        ]);
    }, 5000);

    test("logout deletes local session and best-effort revokes refresh token", async () => {
        const store = new MemoryAuthStore(expiringSession());
        const revoked: string[] = [];
        const manager = new OpenAIChatGptAuthManager({
            harnessHome: "/tmp/harness-auth-test",
            store,
            fetch: async (url, init) => {
                revoked.push(
                    `${fetchInputUrl(url)} ${fetchBodyText(init?.body)}`,
                );
                return jsonResponse({});
            },
        });

        expect(await manager.logout()).toBe(true);
        expect(store.session).toBeUndefined();
        expect(revoked[0]).toContain("/oauth/revoke");
    }, 5000);

    test("redacts sensitive OAuth material in text", () => {
        expect(
            redactOpenAIAuthText('{"access_token":"secret","ok":true}'),
        ).toBe('{"access_token":"<redacted>","ok":true}');
        expect(redactOpenAIAuthText("Bearer abc.def.ghi")).toBe(
            "Bearer <redacted>",
        );
    }, 5000);
});

class MemoryAuthStore implements OpenAIAuthStore {
    public constructor(public session?: OpenAIChatGptSession) {}

    public async loadActive(): Promise<OpenAIChatGptSession | undefined> {
        return this.session;
    }

    public async saveActive(session: OpenAIChatGptSession): Promise<void> {
        this.session = session;
    }

    public async deleteActive(): Promise<boolean> {
        const hadSession = this.session !== undefined;
        this.session = undefined;
        return hadSession;
    }
}

function expiringSession(): OpenAIChatGptSession {
    return {
        version: 1,
        kind: OPENAI_CHATGPT_AUTH_KIND,
        issuer: OPENAI_AUTH_ISSUER,
        accountId: "acct_1",
        accessToken: jwt({
            exp: Math.floor((NOW + 1000) / 1000),
            [AUTH_CLAIM]: { chatgpt_account_id: "acct_1" },
        }),
        refreshToken: "refresh_before",
        idToken: jwt({
            email: "test@example.com",
            [AUTH_CLAIM]: { chatgpt_account_id: "acct_1" },
        }),
        expiresAt: NOW + 1000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function fetchInputUrl(input: URL | RequestInfo): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}

function fetchBodyText(body: BodyInit | null | undefined): string {
    if (body === undefined || body === null) {
        return "";
    }
    if (typeof body === "string") {
        return body;
    }
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    throw new Error(
        `Unsupported test request body type: ${body.constructor.name}`,
    );
}

function tokenResponse(input: {
    refreshToken: string;
}): Record<string, unknown> {
    return {
        id_token: jwt({
            email: "test@example.com",
            [AUTH_CLAIM]: {
                chatgpt_account_id: "acct_1",
                chatgpt_plan_type: "plus",
                workspace_id: "workspace_1",
            },
        }),
        access_token: jwt({
            exp: Math.floor((NOW + 60 * 60 * 1000) / 1000),
            [AUTH_CLAIM]: { chatgpt_account_id: "acct_1" },
        }),
        refresh_token: input.refreshToken,
        expires_in: 3600,
    };
}

function jwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
