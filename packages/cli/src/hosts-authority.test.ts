import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createInProcessMessageConnectionPair, RpcPeer, type RpcConnection } from "@harness/client";
import {
  defaultClientConfig,
  serverInfoRequest,
  type Host,
  type ConnectionCommand,
} from "@harness/connections";
import { HARNESS_PROTOCOL_VERSION, serverModelsRequest } from "@harness/protocol";
import { appProvidersRequest } from "@harness/server/client-protocol";
import { TuiHosts } from "./hosts.ts";

const edge = vi.hoisted(() => ({ command: vi.fn(), connect: vi.fn(), prepare: vi.fn() }));
vi.mock("@harness/connections/node", () => ({
  runConnectionCommand: edge.command,
  connectRemote: edge.connect,
  prepareRemoteRuntime: edge.prepare,
}));
const connections: RpcConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("reconciles external route changes, pending connects and removal while preserving metadata edits", async () => {
  vi.stubEnv("HARNESS_SERVER_PAYLOAD", "/prepared-fixture");
  const remote: Host = {
    id: "remote",
    label: "Work",
    kind: "ssh",
    destination: "first",
    runtime: { source: "development" },
  };
  let config = { ...defaultClientConfig(), hosts: [...defaultClientConfig().hosts, remote] };
  edge.command.mockImplementation(async (command: ConnectionCommand) => {
    if (command.type === "host.select") config = { ...config, selectedHostId: command.id };
    return config;
  });
  edge.prepare.mockResolvedValue({
    node: "node",
    directory: "/runtime",
    home: "/home/fixture/.harness",
    buildId: "a".repeat(64),
    dependencyKey: "b".repeat(64),
    transferred: false,
  });
  let stall = false;
  let entered: () => void = () => undefined;
  edge.connect.mockImplementation(async () => {
    const pair = createInProcessMessageConnectionPair();
    connections.push(pair.left, pair.right);
    const server = new RpcPeer({ role: "server", connection: pair.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "fixture", version: "1" },
      plugins: [],
    }));
    server.onRequest(serverInfoRequest, () => ({
      serverId: randomUUID(),
      instanceId: randomUUID(),
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      home: "/home/fixture/.harness",
      pid: 1,
      platform: "linux" as const,
      buildId: "fixture",
    }));
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.onRequest(appProvidersRequest, () => []);
    if (!stall) server.listen();
    entered();
    return {
      connection: pair.left,
      close: async () => {
        pair.left.dispose();
        pair.right.dispose();
      },
    };
  });
  const hosts = new TuiHosts();
  await hosts.initialize();
  await hosts.select("remote");
  const previous = hosts.selected!.harness!;
  hosts.selected!.presentation.drafts.set("conversation", "private draft");
  config = {
    ...config,
    hosts: [config.hosts[0]!, { ...remote, label: "Renamed", runtime: { source: "managed" } }],
  };
  await hosts.edit({ type: "preferences", keepServerRunning: true });
  await hosts.connect("remote");
  expect(hosts.selected!.harness).toBe(previous);
  expect(hosts.selected!.presentation.drafts.get("conversation")).toBe("private draft");
  await hosts.disconnect("remote");
  stall = true;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = hosts.connect("remote");
  const rejected = expect(pending).rejects.toThrow();
  await ready;
  config = { ...config, hosts: [config.hosts[0]!, { ...remote, destination: "second" }] };
  await hosts.edit({ type: "preferences", keepServerRunning: true });
  await rejected;
  expect(hosts.views.get("remote")!.harness).toBeUndefined();
  expect(hosts.views.get("remote")!.presentation.drafts.size).toBe(0);
  stall = false;
  await hosts.connect("remote");
  expect(edge.connect.mock.lastCall?.[0]).toMatchObject({ destination: "second" });
  const second = hosts.views.get("remote")!.harness!;
  config = defaultClientConfig();
  await hosts.edit({ type: "preferences", keepServerRunning: true });
  expect(second.client.peer.ready).toBe(false);
  expect(hosts.views.has("remote")).toBe(false);
  await hosts.close();
});
