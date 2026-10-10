import { PRODUCT_VERSION } from "@harness/release";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { RpcPeer, createInProcessMessageConnectionPair, type RpcConnection } from "@harness/client";
import {
  defaultClientConfig,
  serverInfoRequest,
  type Host,
  type ConnectionCommand,
} from "@harness/connections";
import { HARNESS_PROTOCOL_VERSION, serverModelsRequest } from "@harness/protocol";
import { appProvidersRequest } from "@harness/server/client-protocol";
import { DesktopHosts } from "./hosts.ts";
import { TuiHosts } from "../../cli/src/hosts.ts";

const edge = vi.hoisted(() => ({
  command: vi.fn(),
  connect: vi.fn(),
  native: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("./transport.ts", () => ({ connectionCommand: edge.command, connectNative: edge.native }));
vi.mock("@harness/connections/node", () => ({
  runConnectionCommand: edge.command,
  connectRemote: edge.connect,
  prepareRemoteRuntime: edge.prepare,
}));
const peers: RpcConnection[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) peer.dispose();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(kind: "desktop" | "tui") {
  vi.stubEnv("HARNESS_SERVER_PAYLOAD", "/fixture");
  const remote: Host = {
    kind: "ssh",
    id: "remote",
    label: "Remote",
    destination: "first",
  };
  let config = { ...defaultClientConfig(), hosts: [...defaultClientConfig().hosts, remote] };
  const runtime = {
    node: "node",
    home: "/home/user/.harness",
    directory: "/runtime",
    buildId: "a".repeat(64),
    transferred: false,
  };
  const command = async (value: ConnectionCommand) =>
    value.type === "runtime.prepare" ? runtime : config;
  edge.command.mockImplementation(command);
  edge.prepare.mockResolvedValue(runtime);
  const connect = async () => {
    const pair = createInProcessMessageConnectionPair();
    peers.push(pair.left, pair.right);
    const server = new RpcPeer({ role: "server", connection: pair.right });
    server.onInitialize(() => ({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "fixture", version: "1" },
      plugins: [],
    }));
    server.onRequest(serverModelsRequest, () => ({
      models: [],
      defaultModel: { provider: "demo", model: "demo-1", preset: null },
    }));
    server.onRequest(appProvidersRequest, () => []);
    server.onRequest(serverInfoRequest, () => ({
      serverId: randomUUID(),
      instanceId: randomUUID(),
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      home: runtime.home,
      pid: 1,
      platform: "linux" as const,
      managementVersion: 1 as const,
      productVersion: PRODUCT_VERSION,
      buildId: "fixture",
    }));
    server.listen();
    return {
      connection: pair.left,
      close: async () => {
        pair.left.dispose();
        pair.right.dispose();
      },
    };
  };
  edge.connect.mockImplementation(connect);
  edge.native.mockImplementation(connect);
  const hosts = kind === "desktop" ? new DesktopHosts() : new TuiHosts();
  await hosts.initialize();
  return {
    hosts,
    remote,
    command,
    replace: (host: Host) => {
      config = { ...config, hosts: [config.hosts[0]!, host] };
    },
  };
}

it.each(["desktop", "tui"] as const)(
  "%s cancels connect/upload while registry adoption is pending",
  async (kind) => {
    const { hosts, command } = await fixture(kind);
    for (const operation of ["connect", "refresh"] as const) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      edge.command.mockImplementation(async (value: ConnectionCommand) => {
        if (value.type === "preferences") {
          entered();
          await gate;
        }
        return command(value);
      });
      const editing = hosts.edit({ type: "preferences", keepServerRunning: true });
      await started;
      const pending = operation === "connect" ? hosts.connect("remote") : hosts.refresh("remote");
      const rejected = expect(pending).rejects.toThrow();
      if (operation === "connect") await hosts.disconnect("remote");
      else hosts.cancel("remote");
      await rejected;
      release();
      await editing;
      expect(edge.prepare).not.toHaveBeenCalled();
      expect(edge.connect).not.toHaveBeenCalled();
      expect(edge.native).toHaveBeenCalledTimes(kind === "desktop" ? 1 : 0);
    }
    await hosts.disconnect("local");
  },
);

it.each(["desktop", "tui"] as const)(
  "%s stop completion closes its captured observer and preserves a replacement",
  async (kind) => {
    const { hosts, remote, command, replace } = await fixture(kind);
    await hosts.connect("remote");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    edge.command.mockImplementation(async (value: ConnectionCommand) => {
      if (value.type === "server.stop") {
        entered();
        await gate;
        return null;
      }
      return command(value);
    });
    const stopping = hosts.stop("remote");
    await started;
    replace({ ...remote, destination: "second" });
    await hosts.edit({ type: "preferences", keepServerRunning: true });
    await hosts.connect("remote");
    const client =
      hosts instanceof DesktopHosts
        ? hosts.views.get("remote")!.session!.client
        : hosts.views.get("remote")!.harness!.client;
    release();
    await stopping;
    expect(client.peer.ready).toBe(true);
    expect(await client.peer.request(serverInfoRequest, {})).toMatchObject({
      home: "/home/user/.harness",
    });
    await hosts.disconnect("remote");
    await hosts.disconnect("local");
  },
);
