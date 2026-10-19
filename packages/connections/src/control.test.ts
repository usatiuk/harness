import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { PRODUCT_VERSION } from "@harness/release";
import { runConnectionCommand, stopRemoteServer } from "./commands.ts";
import { stopConnection } from "./control.ts";
import {
  managementInspectRequest,
  managementStopRequest,
  managementReleaseRequest,
  type ServerIdentity,
  type PreparedRuntime,
} from "./contracts.ts";

const remote = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./remote.ts", async (original) => ({
  ...(await original<typeof import("./remote.ts")>()),
  connectRemote: remote.connect,
}));
afterEach(() => vi.clearAllMocks());

function fixture() {
  // Management controls use the real NDJSON close-after-response contract.
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const pair = {
    left: createNdjsonMessageConnection(inbound, outbound),
    right: createNdjsonMessageConnection(outbound, inbound),
  };
  const identity: ServerIdentity = {
    managementVersion: 1,
    productVersion: PRODUCT_VERSION,
    protocolVersion: 999,
    serverId: randomUUID(),
    instanceId: randomUUID(),
    home: "/home/test/.harness",
    pid: 1234,
    platform: "linux",
    buildId: "future-server",
  };
  pair.right.onRequest(managementInspectRequest.method, () => identity);
  pair.right.listen();
  return { ...pair, identity };
}

it("stops a remote server with an incompatible conversation protocol through management only", async () => {
  const { left, right, identity } = fixture();
  const runtime: PreparedRuntime = {
    node: "/home/test/.harness/runtime/node/22.23.3-linux-x64-glibc/bin/node",
    directory: "/home/test/.harness/server/0.1.0-linux-x64-glibc",
    home: identity.home,
    buildId: "a".repeat(64),
    transferred: false,
  };
  let stopped: unknown;
  right.onRequest(managementStopRequest.method, (params: unknown) => {
    stopped = params;
    setImmediate(() => right.end());
    return { accepted: true };
  });
  const close = vi.fn(async () => {
    left.dispose();
    right.dispose();
  });
  remote.connect.mockResolvedValue({ connection: left, close });
  await stopRemoteServer(
    {
      kind: "ssh",
      id: "remote",
      label: "Remote",
      destination: "host",
    },
    runtime,
    identity,
  );
  expect(stopped).toEqual({ instanceId: identity.instanceId });
  expect(remote.connect.mock.calls[0]?.[3]).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});

it("refuses to stop a replacement instance", async () => {
  const { left, right, identity } = fixture();
  const stop = vi.fn(() => ({ accepted: true }));
  right.onRequest(managementStopRequest.method, stop);
  try {
    await expect(stopConnection(left, { ...identity, instanceId: randomUUID() })).rejects.toThrow(
      "Server instance changed",
    );
    expect(stop).not.toHaveBeenCalled();
  } finally {
    left.dispose();
    right.dispose();
  }
});

it("leaves an owner with another client running after conditional release", async () => {
  const { left, right, identity } = fixture();
  right.onRequest(managementReleaseRequest.method, () => ({ stopping: false }));
  try {
    await stopConnection(left, identity, true);
    await expect(left.sendRequest(managementInspectRequest.method, {})).resolves.toEqual(identity);
  } finally {
    left.dispose();
    right.dispose();
  }
});

it("warns on a busy upgrade without closing the existing owner", async () => {
  const { left, right, identity } = fixture();
  right.onRequest(managementStopRequest.method, (raw: unknown) => {
    expect(raw).toEqual({ instanceId: identity.instanceId, ifIdle: true });
    return { accepted: false };
  });
  try {
    await expect(stopConnection(left, identity, false, true)).rejects.toThrow(
      "finish or stop the active work, then reconnect",
    );
    await expect(left.sendRequest(managementInspectRequest.method, {})).resolves.toEqual(identity);
  } finally {
    left.dispose();
    right.dispose();
  }
});

it.each([false, true])(
  "conditionally releases remote exit without startup, stopping=%s",
  async (stopping) => {
    const { left, right, identity } = fixture();
    const runtime: PreparedRuntime = {
      node: "/runtime/node",
      directory: "/runtime/server",
      home: identity.home,
      buildId: "a".repeat(64),
      transferred: false,
    };
    const release = vi.fn(() => {
      if (stopping) setImmediate(() => right.end());
      return { stopping };
    });
    right.onRequest(managementReleaseRequest.method, release);
    const close = vi.fn(async () => {
      left.dispose();
      right.dispose();
    });
    remote.connect.mockResolvedValue({ connection: left, close });
    const host = { kind: "ssh", id: "alias", label: "Alias", destination: "host" } as const;
    await runConnectionCommand({ type: "desktop.exit", target: { host, runtime }, identity }, "");
    expect(remote.connect).toHaveBeenCalledWith(host, runtime, {}, false);
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);

it("remote exit refuses a replacement owner and closes only its control", async () => {
  const { left, right, identity } = fixture();
  const release = vi.fn(() => ({ stopping: true }));
  right.onRequest(managementReleaseRequest.method, release);
  const close = vi.fn(async () => {
    left.dispose();
    right.dispose();
  });
  remote.connect.mockResolvedValue({ connection: left, close });
  await expect(
    runConnectionCommand(
      {
        type: "desktop.exit",
        target: {
          host: { kind: "ssh", id: "alias", label: "Alias", destination: "host" },
          runtime: {
            node: "/runtime/node",
            directory: "/runtime/server",
            home: identity.home,
            buildId: "a".repeat(64),
            transferred: false,
          },
        },
        identity: { ...identity, instanceId: randomUUID() },
      },
      "",
    ),
  ).rejects.toThrow("Server instance changed");
  expect(release).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("rejects an incomplete control handshake when its transport closes", async () => {
  const { left, right, identity } = fixture();
  right.onRequest(managementInspectRequest.method, () => {
    setImmediate(() => right.end());
    return new Promise<never>(() => undefined);
  });
  try {
    await expect(stopConnection(left, identity, true)).rejects.toThrow("Pending response rejected");
  } finally {
    left.dispose();
    right.dispose();
  }
});
