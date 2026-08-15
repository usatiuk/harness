import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HARNESS_PROTOCOL_VERSION,
  MAX_RPC_FRAME_BYTES,
  REQUEST_CANCELLED_ERROR_CODE,
  defineNotification,
  defineRequest,
  initializeRequest,
} from "@harness/protocol";
import type { InitializeParams, InitializeResult } from "@harness/protocol";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc";
import { createInProcessMessageConnectionPair } from "./in-process.ts";
import { ProtocolError, RpcPeer } from "./peer.ts";

const clientEcho = defineRequest({
  direction: "client-to-server",
  method: "test.clientEcho",
  params: z.strictObject({ value: z.string() }),
  result: z.strictObject({ value: z.string() }),
});

const serverEcho = defineRequest({
  direction: "server-to-client",
  method: "test.serverEcho",
  params: z.strictObject({ value: z.string() }),
  result: z.strictObject({ value: z.string() }),
});

const serverNotice = defineNotification({
  direction: "server-to-client",
  method: "test.notice",
  params: z.strictObject({ value: z.string() }),
});

const initializeParams: InitializeParams = {
  protocolVersion: HARNESS_PROTOCOL_VERSION,
  client: { name: "test-client", version: "1.0.0" },
  plugins: [],
};

const initializeResult: InitializeResult = {
  protocolVersion: HARNESS_PROTOCOL_VERSION,
  server: { name: "test-server", version: "1.0.0" },
  plugins: [],
};

const createPeers = () => {
  const connections = createInProcessMessageConnectionPair();
  const client = new RpcPeer({ role: "client", connection: connections.left });
  const server = new RpcPeer({ role: "server", connection: connections.right });
  server.onInitialize(() => initializeResult);
  client.listen();
  server.listen();
  return { client, server, connections };
};

const initialize = async (client: RpcPeer): Promise<void> => {
  await client.initialize(initializeParams);
};

describe("RpcPeer", () => {
  it("requires one successful initialization before ordinary traffic", async () => {
    const { client, server, connections } = createPeers();
    server.onRequest(clientEcho, (params) => params);

    await expect(client.request(clientEcho, { value: "early" })).rejects.toThrow("not initialized");
    await expect(
      connections.left.sendRequest(clientEcho.method, { value: "early" }),
    ).rejects.toMatchObject({ code: ErrorCodes.ServerNotInitialized });

    await expect(client.initialize(initializeParams)).resolves.toEqual(initializeResult);
    await expect(client.request(clientEcho, { value: "ready" })).resolves.toEqual({
      value: "ready",
    });
    expect(client.ready).toBe(true);
    expect(server.ready).toBe(true);

    await expect(
      connections.left.sendRequest(initializeRequest.method, initializeParams),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidRequest });
  });

  it("correlates concurrent requests in both directions", async () => {
    const { client, server } = createPeers();
    client.onRequest(serverEcho, async ({ value }) => ({ value: `client:${value}` }));
    server.onRequest(clientEcho, async ({ value }) => ({ value: `server:${value}` }));
    await initialize(client);

    // Consume the server's first ID so both peers issue their next request with the same ID.
    await server.request(serverEcho, { value: "warmup" });

    await expect(
      Promise.all([
        client.request(clientEcho, { value: "a" }),
        server.request(serverEcho, { value: "b" }),
      ]),
    ).resolves.toEqual([{ value: "server:a" }, { value: "client:b" }]);
  });

  it("validates outbound parameters and untrusted results", async () => {
    const protocolErrors: ProtocolError[] = [];
    const connections = createInProcessMessageConnectionPair();
    const client = new RpcPeer({
      role: "client",
      connection: connections.left,
      onProtocolError: (error) => protocolErrors.push(error),
    });
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => initializeResult);
    server.onRequest(clientEcho, (params) => params);
    connections.right.onRequest("test.invalidResult", () => ({ value: 42 }));
    client.listen();
    server.listen();
    await initialize(client);

    await expect(
      client.request(clientEcho, { value: 42 } as unknown as { value: string }),
    ).rejects.toThrow();

    const invalidResult = defineRequest({
      direction: "client-to-server",
      method: "test.invalidResult",
      params: z.strictObject({}),
      result: z.strictObject({ value: z.string() }),
    });
    await expect(client.request(invalidResult, {})).rejects.toBeInstanceOf(ProtocolError);
    expect(protocolErrors).toHaveLength(1);
    expect(client.ready).toBe(false);
  });

  it("returns safe errors for invalid parameters and handler failures", async () => {
    const observed: unknown[] = [];
    const connections = createInProcessMessageConnectionPair();
    const client = new RpcPeer({ role: "client", connection: connections.left });
    const server = new RpcPeer({
      role: "server",
      connection: connections.right,
      onHandlerError: (error) => observed.push(error),
    });
    server.onInitialize(() => initializeResult);
    server.onRequest(clientEcho, () => {
      throw new Error("secret server detail");
    });
    client.listen();
    server.listen();
    await initialize(client);

    await expect(
      connections.left.sendRequest(clientEcho.method, { value: 3 }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });

    const error = await client
      .request(clientEcho, { value: "x" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResponseError);
    expect(error).toMatchObject({ code: ErrorCodes.InternalError, message: "internal error" });
    expect(String(error)).not.toContain("secret server detail");
    expect(observed).toHaveLength(1);
  });

  it("cancels a running request through AbortSignal", async () => {
    const { client, server } = createPeers();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    server.onRequest(clientEcho, async (params, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return params;
    });
    await initialize(client);

    const controller = new AbortController();
    const request = client.request(clientEcho, { value: "slow" }, { signal: controller.signal });
    await running;
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: REQUEST_CANCELLED_ERROR_CODE });
  });

  it("does not invoke a handler for a request cancelled before dispatch", async () => {
    const { client, server } = createPeers();
    const handler = vi.fn(async (params: { value: string }) => params);
    server.onRequest(clientEcho, handler);
    await initialize(client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.request(clientEcho, { value: "cancelled" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: REQUEST_CANCELLED_ERROR_CODE });
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers validated notifications and closes on malformed ones", async () => {
    const protocolError = vi.fn();
    const connections = createInProcessMessageConnectionPair();
    const client = new RpcPeer({
      role: "client",
      connection: connections.left,
      onProtocolError: protocolError,
    });
    const server = new RpcPeer({ role: "server", connection: connections.right });
    server.onInitialize(() => initializeResult);
    const received = vi.fn();
    client.onNotification(serverNotice, received);
    client.listen();
    server.listen();
    await initialize(client);

    await server.notify(serverNotice, { value: "hello" });
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ value: "hello" }));

    await connections.right.sendNotification(serverNotice.method, { value: 4 });
    await vi.waitFor(() => expect(protocolError).toHaveBeenCalledOnce());
    expect(client.ready).toBe(false);
  });

  it("enforces the remote frame limit in process too", async () => {
    const { client, server } = createPeers();
    client.onNotification(serverNotice, () => {});
    await initialize(client);
    await expect(
      server.notify(serverNotice, { value: "x".repeat(MAX_RPC_FRAME_BYTES) }),
    ).rejects.toThrow("RPC frame is too large");
    client.close();
    server.close();
  });

  it("closes instead of parking a request when its response exceeds the frame limit", async () => {
    const { client, server } = createPeers();
    server.onRequest(clientEcho, () => ({ value: "x".repeat(MAX_RPC_FRAME_BYTES) }));
    await initialize(client);

    await expect(client.request(clientEcho, { value: "small" })).rejects.toBeDefined();
    expect(client.ready).toBe(false);
    server.close();
  });

  it("rejects pending requests when the peer closes", async () => {
    const { client, server } = createPeers();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    server.onRequest(clientEcho, async () => {
      started();
      return new Promise<never>(() => undefined);
    });
    await initialize(client);

    const request = client.request(clientEcho, { value: "waiting" });
    await running;
    server.close();

    await expect(request).rejects.toBeDefined();
    expect(client.ready).toBe(false);
  });

  it("rejects methods registered or sent in the wrong direction", async () => {
    const { client, server } = createPeers();
    expect(() => client.onRequest(clientEcho, (params) => params)).toThrow("not server-to-client");
    await initialize(client);
    await expect(server.request(clientEcho, { value: "x" })).rejects.toThrow(
      "not server-to-client",
    );
    client.close();
    server.close();
  });
});
