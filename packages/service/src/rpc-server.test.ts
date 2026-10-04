import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HARNESS_PROTOCOL_VERSION, defineRequest } from "@harness/protocol";
import { RpcPeer, createInProcessMessageConnectionPair } from "@harness/client";
import { RpcServer } from "./rpc-server.ts";

const echo = defineRequest({
  direction: "client-to-server",
  method: "test.echo",
  params: z.strictObject({ text: z.string() }),
  result: z.strictObject({ text: z.string() }),
});

describe("RpcServer", () => {
  it("rejects a previous protocol version before admitting application requests", async () => {
    const connection = createInProcessMessageConnectionPair();
    const server = new RpcServer({
      connection: connection.right,
      server: { name: "harness", version: "0.0.0" },
    });
    server.start();
    connection.left.listen();
    try {
      await expect(
        connection.left.sendRequest("initialize", {
          protocolVersion: HARNESS_PROTOCOL_VERSION - 1,
          client: { name: "previous-client", version: "0.0.0" },
          plugins: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(connection.left.sendRequest(echo.method, { text: "early" })).rejects.toThrow();
    } finally {
      connection.left.dispose();
      server.close();
    }
  });

  it("owns initialization and dispatches validated handlers", async () => {
    const connection = createInProcessMessageConnectionPair();
    const server = new RpcServer({
      connection: connection.right,
      server: { name: "harness", version: "0.0.0" },
    });
    server.onRequest(echo, ({ text }) => ({ text: text.toUpperCase() }));

    const client = new RpcPeer({ role: "client", connection: connection.left });
    client.listen();
    server.start();
    await expect(
      client.initialize({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        client: { name: "test", version: "1" },
        plugins: [],
      }),
    ).resolves.toEqual({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "harness", version: "0.0.0" },
      plugins: [],
    });
    await expect(client.request(echo, { text: "hello" })).resolves.toEqual({
      text: "HELLO",
    });

    client.close();
    server.close();
  });
});
