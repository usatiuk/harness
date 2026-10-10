import { PRODUCT_VERSION } from "@harness/release";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { authenticateSocket, connectDiscovered, listenLocal } from "./local.ts";

vi.mock("@harness/secrets", () => {
  class FixtureSecretStore {
    async get() {
      return "123abc-fixture-token";
    }
  }
  return { DpapiSecretStore: FixtureSecretStore, FileSecretStore: FixtureSecretStore };
});

it("authenticates through local IPC with a home too long for a Unix socket path", async () => {
  const home = resolve("fixture-home", "x".repeat(180), "y".repeat(180));
  const identity = {
    home,
    serverId: randomUUID(),
    instanceId: randomUUID(),
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    pid: process.pid,
    platform: process.platform as "win32" | "linux" | "darwin",
    managementVersion: 1 as const,
    productVersion: PRODUCT_VERSION,
    buildId: "fixture",
  };
  let admitted: import("node:net").Socket | undefined;
  const listener = await listenLocal(
    home,
    identity.instanceId,
    (socket) => {
      admitted = socket;
      void authenticateSocket(socket).then((token) => {
        expect(token).toBe("123abc-fixture-token");
        socket.write(`${JSON.stringify(identity)}\n`);
      });
    },
    (error) => {
      throw error;
    },
  );
  try {
    expect(Buffer.byteLength(listener.endpoint.path)).toBeLessThan(104);
    const attached = await connectDiscovered(home, { ...identity, endpoint: listener.endpoint });
    expect(attached.identity).toEqual(identity);
    const closed = once(attached.socket, "close");
    attached.socket.destroy();
    await closed;
  } finally {
    admitted?.destroy();
    await listener.close();
  }
});
