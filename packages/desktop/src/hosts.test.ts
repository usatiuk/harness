import { PRODUCT_VERSION } from "@harness/release";
import { afterEach, expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair, RpcPeer, type RpcConnection } from "@harness/client";
import {
  defaultClientConfig,
  serverInfoRequest,
  type Host,
  type ConnectionCommand,
} from "@harness/connections";
import { HARNESS_PROTOCOL_VERSION, serverModelsRequest } from "@harness/protocol";
import { randomUUID } from "node:crypto";
import { DesktopHosts } from "./hosts.ts";

const native = vi.hoisted(() => ({
  command: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn<(id: unknown) => Promise<void>>(),
}));
vi.mock("./transport.ts", () => ({
  connectionCommand: native.command,
  connectNative: native.connect,
}));
const connections: RpcConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("adopts external route edits and removals before reusing a saved connection", async () => {
  const remote: Host = {
    id: "remote",
    label: "Work",
    kind: "ssh",
    destination: "first",
  };
  let config = { ...defaultClientConfig(), hosts: [...defaultClientConfig().hosts, remote] };
  native.command.mockImplementation(async () => config);
  native.disconnect.mockResolvedValue(undefined);
  native.connect.mockImplementation(async ({ host }: { host: Host }) => {
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
      managementVersion: 1 as const,
      productVersion: PRODUCT_VERSION,
      buildId: "fixture",
    }));
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.listen();
    return {
      connection: pair.left,
      close: async () => {
        await native.disconnect(host);
        pair.right.dispose();
      },
    };
  });
  // Provisioning is an OS boundary; the authenticated RPC peers above remain real.
  const runtime = {
    node: "node",
    directory: "/runtime",
    home: "/home/fixture/.harness",
    buildId: "a".repeat(64),
    transferred: false,
  };
  native.command.mockImplementation(async (command: ConnectionCommand) => {
    if (command.type === "host.select") config = { ...config, selectedHostId: command.id };
    return command.type === "runtime.prepare" ? runtime : config;
  });
  const hosts = new DesktopHosts();
  await hosts.initialize();
  await hosts.select("remote");
  const previous = hosts.selected!.session!;
  config = {
    ...config,
    hosts: [config.hosts[0]!, { ...remote, label: "Renamed" }],
  };
  await hosts.edit({ type: "preferences", keepServerRunning: true });
  await hosts.connect("remote");
  expect(hosts.selected!.session).toBe(previous);
  config = { ...config, hosts: [config.hosts[0]!, { ...remote, destination: "second" }] };
  await hosts.select("remote");
  expect(previous.client.peer.ready).toBe(false);
  expect(hosts.selected!.session).not.toBe(previous);
  expect(native.connect.mock.lastCall?.[0]).toMatchObject({ host: { destination: "second" } });
  const second = hosts.selected!.session!;
  config = defaultClientConfig();
  await hosts.edit({ type: "preferences", keepServerRunning: true });
  expect(second.client.peer.ready).toBe(false);
  expect(hosts.views.has("remote")).toBe(false);
  await hosts.disconnect("local");
});

function stalledPeer() {
  const pair = createInProcessMessageConnectionPair();
  connections.push(pair.left, pair.right);
  let connected!: () => void;
  const started = new Promise<void>((resolve) => {
    connected = resolve;
  });
  native.command.mockResolvedValue(defaultClientConfig());
  native.connect.mockImplementation(async (_target, onClosed: (message: string) => void) => {
    native.disconnect.mockImplementation(async () => {
      onClosed("Harness server disconnected");
      pair.right.dispose();
    });
    connected();
    return { connection: pair.left, close: () => native.disconnect(1) };
  });
  return started;
}

it("disconnect forwards cancellation while native Local preparation is still pending", async () => {
  native.command.mockResolvedValue(defaultClientConfig());
  let preparing!: () => void;
  const prepared = new Promise<void>((resolve) => {
    preparing = resolve;
  });
  native.connect.mockImplementation(async (_target, _onClosed, signal: AbortSignal) => {
    preparing();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Fixture preparation cancelled", { cause: signal.reason })),
        { once: true },
      );
    });
  });
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await prepared;
  const connecting = hosts.connect("local");
  const rejected = expect(connecting).rejects.toThrow();
  await hosts.disconnect("local");
  await rejected;
  await loading;
  expect(hosts.views.get("local")?.session).toBeUndefined();
});

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

it("retains the native startup failure instead of the pending RPC disposal error", async () => {
  const started = stalledPeer();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await started;
  const onClosed = native.connect.mock.lastCall![1] as (message: string) => void;
  const diagnostic = "Server startup failed (exit 1); see /home/.harness/.server/startup.log";
  onClosed(diagnostic);
  let draining!: () => void;
  const closing = new Promise<void>((resolve) => {
    draining = resolve;
  });
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  native.disconnect.mockImplementation(async () => {
    draining();
    await closed;
    onClosed("Could not detach the native Harness bridge");
    throw new Error("Bridge exited before initialization");
  });
  connections.at(-2)!.dispose();
  await closing;
  deadline.abort(new DOMException("Connection readiness timed out", "TimeoutError"));
  finish();
  await expect(loading).resolves.toBeUndefined();
  expect(hosts.selected?.error).toBe(diagnostic);
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
      managementVersion: 1 as const,
      productVersion: PRODUCT_VERSION,
      buildId: "fixture",
    };
    server.onRequest(serverInfoRequest, () => identity);
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.listen();
    return { connection: pair.left, close: () => native.disconnect(connections.length) };
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
