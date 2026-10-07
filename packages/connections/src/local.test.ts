import { createServer, type TcpNetConnectOpts } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { connectDiscovered } from "./local.ts";

const fixture = vi.hoisted(() => ({
  port: 0,
  selfConnected: false,
  socket: undefined as import("node:net").Socket | undefined,
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: (options: TcpNetConnectOpts) => {
      const socket = actual.createConnection({
        ...options,
        localAddress: "127.0.0.1",
        localPort: fixture.port,
      });
      fixture.socket = socket;
      socket.once("connect", () => {
        fixture.selfConnected =
          socket.localAddress === socket.remoteAddress && socket.localPort === socket.remotePort;
      });
      return socket;
    },
  };
});

vi.mock("@harness/secrets", () => {
  class FixtureSecretStore {
    async get() {
      return "123abc-fixture-token";
    }
  }
  return { DpapiSecretStore: FixtureSecretStore, FileSecretStore: FixtureSecretStore };
});

it.runIf(process.platform === "win32" || process.platform === "linux")(
  "classifies a real TCP self-connection as unavailable before sending authentication",
  async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    fixture.port = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const home = resolve("fixture-home");
    try {
      await expect(
        connectDiscovered(home, {
          home,
          port: fixture.port,
          serverId: randomUUID(),
          instanceId: randomUUID(),
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          pid: process.pid,
          platform: "linux",
          buildId: "fixture",
        }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(fixture.selfConnected).toBe(true);
      expect(fixture.socket?.bytesWritten).toBe(0);
      expect(fixture.socket?.destroyed).toBe(true);
    } finally {
      fixture.socket?.destroy();
    }
  },
);
