import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { MemorySecretStore } from "@harness/secrets";
import { McpRuntime, mcpConfigSchema } from "./index.ts";
import { oauthFixture } from "./testing-fixture.ts";
import { scopedSecrets } from "./credentials.ts";
import { McpOAuth } from "./oauth.ts";

function callback(attempt: { url: string; redirectUrl: string }, state?: string) {
  const url = new URL(attempt.redirectUrl);
  url.searchParams.set("state", state ?? new URL(attempt.url).searchParams.get("state")!);
  url.searchParams.set("code", "code-1");
  return url.href;
}

it("keeps startup/Test noninteractive, performs explicit DCR+PKCE, binds credentials, refreshes, and logs out", async () => {
  const fixture = await oauthFixture(),
    secrets = new MemorySecretStore();
  const config = mcpConfigSchema.parse({
    servers: {
      oauth: {
        transport: {
          type: "http",
          url: fixture.url,
          headers: { "X-Secret": { type: "literal", value: "resource-only" } },
          auth: { type: "oauth", scopes: ["read"] },
        },
      },
    },
  });
  const runtime = new McpRuntime(config, secrets);
  try {
    await runtime.initialize();
    expect(runtime.tools()).toEqual([]);
    expect((await runtime.statuses())[0]).toMatchObject({
      status: "auth-required",
      authenticated: false,
    });
    expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "auth-required",
    });
    expect(fixture.registrations).toEqual([]);
    const attempt = await runtime.startAuth("oauth", config.servers["oauth"]!);
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.registrations[0]).toMatchObject({
      redirect_uris: [attempt.redirectUrl],
      token_endpoint_auth_method: "none",
    });
    await expect(
      runtime.completeAuth(attempt.attemptId, callback(attempt, "wrong-state")),
    ).rejects.toThrow();
    expect(fixture.exchanges).toEqual([]);
    await runtime.completeAuth(attempt.attemptId, callback(attempt));
    expect(runtime.hasAttempt(attempt.attemptId)).toBe(false);
    const exchange = fixture.exchanges[0]!;
    expect(exchange.get("resource")).toBe(fixture.url);
    expect(exchange.get("redirect_uri")).toBe(attempt.redirectUrl);
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(
      new URL(attempt.url).searchParams.get("code_challenge"),
    );
    expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "ready",
    });
    fixture.expire();
    expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "ready",
    });
    expect(fixture.exchanges[1]?.get("grant_type")).toBe("refresh_token");
    expect(
      fixture.requests.filter((r) => r.url !== "/mcp").every((r) => !r.custom && !r.authorization),
    ).toBe(true);
    const changed = structuredClone(config.servers["oauth"]!);
    if (changed.transport.type !== "http") throw new Error("expected HTTP");
    changed.transport.url += "?other";
    expect(await runtime.test("oauth", changed)).toMatchObject({ status: "auth-required" });
    await runtime.logout("oauth", config.servers["oauth"]!);
    expect((await runtime.statuses())[0]).toMatchObject({ authenticated: false });
    expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "auth-required",
    });
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("accepts a real loopback callback and cancellation closes the host-owned listener", async () => {
  const fixture = await oauthFixture();
  const config = mcpConfigSchema.parse({
    servers: {
      oauth: {
        transport: {
          type: "http",
          url: fixture.url,
          auth: { type: "oauth", clientId: "pre-registered" },
        },
      },
    },
  });
  const runtime = new McpRuntime(config, new MemorySecretStore());
  try {
    const attempt = await runtime.startAuth("oauth", config.servers["oauth"]!);
    expect((await fetch(callback(attempt))).status).toBe(200);
    // Wait for the actual callback exchange and owner state, not its HTTP response.
    await vi.waitFor(async () =>
      expect((await runtime.statuses())[0]).toMatchObject({
        authenticated: true,
        signingIn: false,
      }),
    );
    expect(fixture.registrations).toEqual([]);
    expect(fixture.exchanges[0]?.get("client_id")).toBe("pre-registered");
    const cancelled = await runtime.startAuth("oauth", config.servers["oauth"]!);
    await runtime.cancelAuth(cancelled.attemptId);
    await expect(fetch(callback(cancelled))).rejects.toThrow();
    await expect(runtime.completeAuth(cancelled.attemptId, callback(cancelled))).rejects.toThrow();
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

it("uses a supplied metadata client ID and explains unavailable registration", async () => {
  for (const metadataClient of [false, true]) {
    const fixture = await oauthFixture({ dcr: false, metadataClient });
    const config = mcpConfigSchema.parse({
      servers: {
        oauth: {
          transport: {
            type: "http",
            url: fixture.url,
            auth: {
              type: "oauth",
              ...(metadataClient
                ? { clientMetadataUrl: "https://harness.example/client.json" }
                : {}),
            },
          },
        },
      },
    });
    const runtime = new McpRuntime(config, new MemorySecretStore());
    try {
      if (metadataClient) {
        const attempt = await runtime.startAuth("oauth", config.servers["oauth"]!);
        expect(new URL(attempt.url).searchParams.get("client_id")).toBe(
          "https://harness.example/client.json",
        );
        await runtime.completeAuth(attempt.attemptId, callback(attempt));
        expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
          status: "ready",
        });
      } else {
        await expect(runtime.startAuth("oauth", config.servers["oauth"]!)).rejects.toThrow(
          "Configure a client ID",
        );
        expect((await runtime.statuses())[0]).toMatchObject({ signingIn: false });
      }
      expect(fixture.registrations).toEqual([]);
    } finally {
      await runtime.close();
      await fixture.close();
    }
  }
});

it("reuses stored client/tokens after restart and binds them to scope and client-auth configuration", async () => {
  const fixture = await oauthFixture(),
    secrets = new MemorySecretStore();
  const config = mcpConfigSchema.parse({
    servers: {
      oauth: {
        transport: { type: "http", url: fixture.url, auth: { type: "oauth", scopes: ["read"] } },
      },
    },
  });
  const first = new McpRuntime(config, secrets);
  const attempt = await first.startAuth("oauth", config.servers["oauth"]!);
  await first.completeAuth(attempt.attemptId, callback(attempt));
  await first.close();
  const restarted = new McpRuntime(config, secrets);
  try {
    await restarted.initialize();
    expect((await restarted.statuses())[0]).toMatchObject({ status: "ready", authenticated: true });
    const again = await restarted.startAuth("oauth", config.servers["oauth"]!);
    expect(fixture.registrations).toHaveLength(1);
    await restarted.cancelAuth(again.attemptId);
    for (const auth of [
      { type: "oauth", scopes: ["write"] },
      { type: "oauth", scopes: ["read"], clientId: "different" },
    ]) {
      const changed = mcpConfigSchema.parse({
        servers: { oauth: { transport: { type: "http", url: fixture.url, auth } } },
      }).servers["oauth"]!;
      expect(await restarted.test("oauth", changed)).toMatchObject({ status: "auth-required" });
    }
    await scopedSecrets(secrets, "oauth", "oauth").set("tokens", "corrupt private token");
    expect((await restarted.statuses())[0]).toMatchObject({ authenticated: false });
    expect(await restarted.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "auth-required",
    });
    await scopedSecrets(secrets, "oauth", "oauth").set("client", "corrupt private client");
    const recovered = await restarted.startAuth("oauth", config.servers["oauth"]!);
    expect(fixture.registrations).toHaveLength(2);
    await restarted.completeAuth(recovered.attemptId, callback(recovered));
    expect(await restarted.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "ready",
    });
  } finally {
    await restarted.close();
    await fixture.close();
  }
});

it("cancels a sign-in admitted just before logout, including listener setup", async () => {
  const fixture = await oauthFixture();
  const owner = new McpOAuth(new MemorySecretStore(), new MemorySecretStore(), {});
  try {
    const starting = owner.start({ url: fixture.url, auth: { type: "oauth", scopes: [] } });
    const rejected = expect(starting).rejects.toThrow();
    await owner.logout();
    await rejected;
    expect(owner.attemptId).toBeUndefined();
    expect(fixture.registrations).toEqual([]);
  } finally {
    await owner.close();
    await fixture.close();
  }
});

it("expires an unanswered sign-in and closes its callback listener", async () => {
  const fixture = await oauthFixture();
  const config = mcpConfigSchema.parse({
    servers: { s: { transport: { type: "http", url: fixture.url, auth: { type: "oauth" } } } },
  });
  const runtime = new McpRuntime(config, new MemorySecretStore());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const attempt = await runtime.startAuth("s", config.servers["s"]!);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.hasAttempt(attempt.attemptId)).toBe(false);
    await expect(fetch(callback(attempt))).rejects.toThrow();
    expect(fixture.exchanges).toEqual([]);
  } finally {
    vi.useRealTimers();
    await runtime.close();
    await fixture.close();
  }
});

it("drains an admitted refresh before logout deletes rotating tokens", async () => {
  const fixture = await oauthFixture();
  const config = mcpConfigSchema.parse({
    servers: { oauth: { transport: { type: "http", url: fixture.url, auth: { type: "oauth" } } } },
  });
  const runtime = new McpRuntime(config, new MemorySecretStore());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    const attempt = await runtime.startAuth("oauth", config.servers["oauth"]!);
    await runtime.completeAuth(attempt.attemptId, callback(attempt));
    fixture.expire();
    fixture.hold(async () => {
      entered();
      await gate;
    });
    const testing = runtime.test("oauth", config.servers["oauth"]!);
    await started;
    const logout = runtime.logout("oauth", config.servers["oauth"]!);
    release();
    await Promise.all([testing, logout]);
    expect((await runtime.statuses())[0]).toMatchObject({ authenticated: false });
    expect(await runtime.test("oauth", config.servers["oauth"]!)).toMatchObject({
      status: "auth-required",
    });
  } finally {
    release();
    await runtime.close();
    await fixture.close();
  }
});
