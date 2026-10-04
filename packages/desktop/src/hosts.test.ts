import { afterEach, expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair, RpcPeer, type RpcConnection } from "@harness/client";
import {
  defaultClientConfig,
  serverInfoRequest,
  type ConnectionCommand,
} from "@harness/connections";
import { HARNESS_PROTOCOL_VERSION, serverModelsRequest } from "@harness/protocol";
import { randomUUID } from "node:crypto";
import { DesktopHosts } from "./hosts.ts";

const native = vi.hoisted(() => ({
  command: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./transport.ts", () => ({
  connectionCommand: native.command,
  connectNative: native.connect,
  disconnectNative: native.disconnect,
}));
const connections: RpcConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function stalledPeer() {
  const pair = createInProcessMessageConnectionPair();
  connections.push(pair.left, pair.right);
  let connected!: () => void;
  const started = new Promise<void>((resolve) => {
    connected = resolve;
  });
  native.command.mockResolvedValue(defaultClientConfig());
  native.connect.mockImplementation(
    async (_host, _runtime, onClosed: (message: string) => void) => {
      native.disconnect.mockImplementation(async () => {
        onClosed("Harness server disconnected");
        pair.right.dispose();
      });
      connected();
      return { connection: pair.left, id: 1 };
    },
  );
  return started;
}

it("disconnect cancels a desktop peer that never initializes", async () => {
  const started = stalledPeer();
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await started;
  await hosts.disconnect("local");
  await loading;
  expect(hosts.selected?.session).toBeUndefined();
  expect(hosts.selected?.progress).toBeUndefined();
});

it("readiness expiry closes the stalled peer and reports the deadline", async () => {
  const started = stalledPeer();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await started;
  deadline.abort(new DOMException("Connection readiness timed out", "TimeoutError"));
  await loading;
  expect(hosts.selected?.error).toBe("Connection readiness timed out");
  expect(hosts.selected?.session).toBeUndefined();
  expect(hosts.selected?.progress).toBeUndefined();
});

it("restores presentation for the same server and isolates a changed target under one saved entry", async () => {
  let config = defaultClientConfig();
  let serverId = randomUUID();
  native.command.mockImplementation(async (command: ConnectionCommand) => {
    if (command.type === "host.save") config = { ...config, hosts: [command.host] };
    return config;
  });
  native.connect.mockImplementation(async () => {
    const pair = createInProcessMessageConnectionPair();
    connections.push(pair.left, pair.right);
    const server = new RpcPeer({ role: "server", connection: pair.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "fixture", version: "1" },
      plugins: [],
    }));
    const identity = {
      serverId,
      instanceId: randomUUID(),
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      home: "/home/fixture/.harness",
      pid: 1,
      platform: "linux" as const,
      buildId: "fixture",
    };
    server.onRequest(serverInfoRequest, () => identity);
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.listen();
    return { connection: pair.left, id: connections.length };
  });
  native.disconnect.mockResolvedValue(undefined);
  const hosts = new DesktopHosts();
  await hosts.initialize();
  expect(hosts.selected?.error).toBeUndefined();
  const storage = new Map<string, string>();
  const previous = hosts.selected!.session!;
  storage.set(previous.storageKey("route"), "/conversations/old-server-conversation");
  storage.set(previous.storageKey("last-directory"), "/home/fixture/project");
  await hosts.edit({ type: "host.save", host: { ...hosts.selected!.host, label: "Renamed" } });
  await hosts.connect("local");
  expect(storage.get(hosts.selected!.session!.storageKey("route"))).toBe(
    "/conversations/old-server-conversation",
  );
  expect(storage.get(hosts.selected!.session!.storageKey("last-directory"))).toBe(
    "/home/fixture/project",
  );
  serverId = randomUUID();
  await hosts.reconnect("local");
  expect(storage.get(hosts.selected!.session!.storageKey("route"))).toBeUndefined();
  expect(storage.get(hosts.selected!.session!.storageKey("last-directory"))).toBeUndefined();
  await hosts.disconnect("local");
});
