import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { HarnessService, HarnessRpcHost, HarnessRpcSession } from "@harness/service";
import { InMemoryStore } from "@harness/store";
import { MemorySecretStore } from "@harness/secrets";
import { McpRuntime } from "@harness/mcp";
import {
  mcpSettingsGet,
  mcpSettingsSet,
  mcpCredentialSet,
  mcpCredentialDelete,
  mcpTest,
  mcpToolsList,
  mcpAuthStart,
  mcpAuthComplete,
  mcpAuthCancel,
} from "@harness/mcp/client";
import { registerMcpApi } from "./mcp.ts";
import { oauthFixture } from "../../mcp/src/testing-fixture.ts";

it("exposes host-owned MCP settings and credentials over real RPC without echoing secrets or hot-reloading", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-rpc-"));
  const runtime = new McpRuntime({}, new MemorySecretStore());
  const service = new HarnessService({
    home,
    store: new InMemoryStore(),
    plugins: [runtime.plugin()],
    defaults: { model: { provider: "fake", model: "fake" } },
  });
  const host = new HarnessRpcHost(service),
    pair = createInProcessMessageConnectionPair();
  const session = new HarnessRpcSession({
    connection: pair.right,
    host,
    server: { name: "test", version: "1" },
  });
  const api = registerMcpApi(session, runtime, home);
  session.start();
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "test", version: "1" },
  });
  try {
    await client.start();
    await client.peer.request(mcpSettingsSet, {
      config: {
        servers: {
          missing: {
            transport: {
              type: "http",
              url: "http://127.0.0.1:1/mcp",
              headers: { "X-Key": { type: "secret", slot: "oauth/tokens" } },
            },
          },
        },
      },
    });
    await client.peer.request(mcpCredentialSet, {
      serverId: "missing",
      slot: "oauth/tokens",
      value: "private-value",
    });
    const settings = await client.peer.request(mcpSettingsGet, {});
    expect(settings).toMatchObject({
      restartRequired: true,
      active: [{ credentials: [{ slot: "oauth/tokens", present: true }] }],
    });
    expect(JSON.stringify(settings)).not.toContain("private-value");
    expect(await readFile(join(home, "settings.json"), "utf8")).not.toContain("private-value");
    expect(await client.peer.request(mcpToolsList, {})).toEqual([]);
    await expect(client.peer.request(mcpTest, { serverId: "constructor" })).rejects.toThrow(
      "Unknown MCP server",
    );
    expect(await client.peer.request(mcpTest, { serverId: "missing" })).toMatchObject({
      status: "unavailable",
    });
    await client.peer.request(mcpCredentialDelete, { serverId: "missing", slot: "oauth/tokens" });
    expect(await client.peer.request(mcpSettingsGet, {})).toMatchObject({
      active: [{ credentials: [{ present: false }] }],
    });
    await expect(
      client.peer.request(mcpSettingsSet, { config: { unexpected: true } }),
    ).rejects.toMatchObject({
      issues: [{ code: "unrecognized_keys", keys: ["unexpected"], path: ["config"] }],
    });
    await expect(
      pair.left.sendRequest(mcpSettingsSet.method, {
        config: JSON.parse(
          '{"servers":{"__proto__":{"transport":{"type":"stdio","executable":"node"}}}}',
        ) as unknown,
      }),
    ).rejects.toThrow("invalid parameters");
    expect(await client.peer.request(mcpSettingsGet, {})).toMatchObject({
      config: settings.config,
    });
    await expect(client.create({ overrides: { plugins: { mcp: {} } } })).rejects.toThrow(
      "internal error",
    );
    await expect(
      service.createConversation({ overrides: { plugins: { mcp: {} } } }),
    ).rejects.toThrow("global");
  } finally {
    client.closeConnection();
    await api.close();
    await host.shutdown();
    await session.shutdown();
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("owns sign-in by the initiating RPC session and closes its loopback listener on detach", async () => {
  const fixture = await oauthFixture(),
    home = await mkdtemp(join(tmpdir(), "mcp-auth-rpc-"));
  const runtime = new McpRuntime({}, new MemorySecretStore());
  const service = new HarnessService({
    home,
    store: new InMemoryStore(),
    plugins: [],
    defaults: { model: { provider: "fake", model: "fake" } },
  });
  const host = new HarnessRpcHost(service);
  const connect = async () => {
    const pair = createInProcessMessageConnectionPair();
    const session = new HarnessRpcSession({
      connection: pair.right,
      host,
      server: { name: "test", version: "1" },
    });
    const api = registerMcpApi(session, runtime, home);
    session.start();
    const client = new HarnessClient({
      connection: pair.left,
      client: { name: "test", version: "1" },
    });
    await client.start();
    return { session, api, client };
  };
  const first = await connect(),
    second = await connect();
  try {
    await first.client.peer.request(mcpSettingsSet, {
      config: {
        servers: {
          remote: { transport: { type: "http", url: fixture.url, auth: { type: "oauth" } } },
        },
      },
    });
    const attempt = await first.client.peer.request(mcpAuthStart, { serverId: "remote" });
    const callback = new URL(attempt.redirectUrl);
    callback.searchParams.set("code", "one");
    callback.searchParams.set("state", new URL(attempt.url).searchParams.get("state")!);
    await expect(
      second.client.peer.request(mcpAuthComplete, {
        attemptId: attempt.attemptId,
        callbackUrl: callback.href,
      }),
    ).rejects.toThrow("Unknown sign-in");
    await expect(
      second.client.peer.request(mcpAuthCancel, { attemptId: attempt.attemptId }),
    ).rejects.toThrow("Unknown sign-in");
    expect(fixture.exchanges).toHaveLength(0);
    first.client.closeConnection();
    await first.api.close();
    await first.session.shutdown(false);
    await expect(fetch(callback)).rejects.toThrow();
    expect(runtime.hasAttempt(attempt.attemptId)).toBe(false);
    const next = await second.client.peer.request(mcpAuthStart, { serverId: "remote" });
    const pasted = new URL(next.redirectUrl);
    pasted.searchParams.set("code", "two");
    pasted.searchParams.set("state", new URL(next.url).searchParams.get("state")!);
    await second.client.peer.request(mcpAuthComplete, {
      attemptId: next.attemptId,
      callbackUrl: pasted.href,
    });
    expect(await second.client.peer.request(mcpSettingsGet, {})).toMatchObject({
      active: [{ authenticated: true, signingIn: false }],
    });
  } finally {
    first.client.closeConnection();
    second.client.closeConnection();
    await Promise.all([first.api.close(), second.api.close()]);
    await host.shutdown();
    await Promise.all([first.session.shutdown(), second.session.shutdown()]);
    await runtime.close();
    await fixture.close();
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
