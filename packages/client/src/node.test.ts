import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Trace, TraceFormat, type Message } from "vscode-jsonrpc";
import { MAX_RPC_FRAME_BYTES, HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { RpcPeer } from "./peer.ts";
import {
  createNdjsonMessageConnection,
  createNdjsonTransport,
  NdjsonMessageReader,
  NdjsonMessageWriter,
} from "./node.ts";

const notification = (method: string, params?: unknown): Message =>
  ({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) as Message;

describe("NDJSON transport", () => {
  it.each([
    ["a final response", true],
    ["an unanswered request", false],
  ])("settles %s and preceding frames before EOF closes the peer", async (_name, responds) => {
    const input = new PassThrough(),
      output = new PassThrough();
    const connection = createNdjsonMessageConnection(input, output);
    const peer = new RpcPeer({ role: "client", connection });
    let closed!: () => void;
    const closure = new Promise<void>((resolve) => {
      closed = resolve;
    });
    connection.onClose(closed);
    const notifications: string[] = [];
    connection.onNotification("preceding", () => notifications.push("preceding"));
    peer.listen();
    let sent!: (id: number) => void;
    const requestSent = new Promise<number>((resolve) => {
      sent = resolve;
    });
    output.once("data", (chunk: Buffer) =>
      sent((JSON.parse(chunk.toString("utf8")) as { id: number }).id),
    );
    const initializing = peer.initialize({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      client: { name: "EOF test", version: "1" },
      plugins: [],
    });
    const id = await requestSent;
    const result = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      server: { name: "server", version: "1" },
      plugins: [],
    };
    input.end(
      `${JSON.stringify(notification("preceding"))}\n${responds ? `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n` : ""}`,
    );
    output.destroy();
    if (responds) await expect(initializing).resolves.toEqual(result);
    else await expect(initializing).rejects.toThrow("connection got disposed");
    expect(notifications).toEqual(["preceding"]);
    await closure;
    expect(peer.ready).toBe(false);
    output.destroy();
  });
  it("drains an accepted RPC response after peer closure before destroying output", async () => {
    const input = new PassThrough();
    const clientInput = new PassThrough();
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let first = true;
    const output = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        const deliver = () => {
          clientInput.write(chunk);
          done();
        };
        if (first) {
          first = false;
          release = deliver;
          started();
        } else deliver();
      },
    });
    const transport = createNdjsonTransport(input, output);
    const connection = transport.connection;
    const client = createNdjsonMessageConnection(clientInput, input);
    let queued!: () => void;
    const responseQueued = new Promise<void>((resolve) => {
      queued = resolve;
    });
    await connection.trace(
      Trace.Messages,
      {
        log: (event: unknown) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "send-response"
          )
            queued();
        },
      },
      { traceFormat: TraceFormat.JSON },
    );
    connection.onRequest("stop", () => ({ accepted: true }));
    connection.listen();
    client.listen();
    const firstFrame = connection.sendNotification("preceding");
    await writing;
    let received = false;
    const response = client.sendRequest("stop", {}).then((result) => {
      received = true;
      return result;
    });
    await responseQueued;
    connection.end();
    connection.dispose();
    const cancellation = new AbortController();
    const abandoned = transport.drain(cancellation.signal);
    cancellation.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    const drained = transport.drain(new AbortController().signal);
    expect(output.writableFinished).toBe(false);
    expect(received).toBe(false);
    release();
    await drained;
    await firstFrame;
    expect(await response).toEqual({ accepted: true });
    expect(output.writableFinished).toBe(true);
    output.destroy();
    input.destroy();
    client.dispose();
    clientInput.destroy();
  });
  it("reads split frames and writes compact one-line JSON", async () => {
    const stream = new PassThrough();
    const reader = new NdjsonMessageReader(stream);
    const messages: Message[] = [];
    reader.listen((message) => messages.push(message));
    stream.write('{"jsonrpc":"2.0","method":"first"}\n{"jsonrpc"');
    stream.write(':"2.0","method":"second"}\n');
    expect(messages.map((message) => (message as { method?: string }).method)).toEqual([
      "first",
      "second",
    ]);

    const output = new PassThrough();
    let encoded = "";
    output.on("data", (chunk: Buffer) => (encoded += chunk.toString("utf8")));
    const writer = new NdjsonMessageWriter(output);
    await writer.write(notification("hello", { text: "a\nb" }));
    expect(encoded).toBe('{"jsonrpc":"2.0","method":"hello","params":{"text":"a\\nb"}}\n');
  });

  it("closes on malformed or oversized input and rejects oversized output", async () => {
    const malformed = new PassThrough();
    const reader = new NdjsonMessageReader(malformed);
    const errors: Error[] = [];
    reader.onError((error) => errors.push(error));
    reader.listen(() => {});
    malformed.write("not-json\n");
    expect(errors[0]?.message).toContain("Unexpected token");

    const oversized = new PassThrough();
    const oversizedReader = new NdjsonMessageReader(oversized);
    const oversizedErrors: Error[] = [];
    oversizedReader.onError((error) => oversizedErrors.push(error));
    oversizedReader.listen(() => {});
    oversized.write("x".repeat(MAX_RPC_FRAME_BYTES + 1));
    expect(oversizedErrors[0]?.message).toBe("RPC frame is too large");

    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    const writer = new NdjsonMessageWriter(sink);
    await expect(
      writer.write(notification("huge", "x".repeat(MAX_RPC_FRAME_BYTES))),
    ).rejects.toThrow("RPC frame is too large");
  });

  it("bounds bytes queued behind a stalled output", async () => {
    const pending: Array<() => void> = [];
    const sink = new Writable({
      write: (_chunk, _encoding, done) => pending.push(() => done()),
      highWaterMark: 1,
    });
    const writer = new NdjsonMessageWriter(sink);
    let closed = false;
    writer.onClose(() => (closed = true));
    const writes = [
      writer.write(notification("one", "x".repeat(3_000_000))),
      writer.write(notification("two", "x".repeat(3_000_000))),
    ];
    await expect(writer.write(notification("three", "x".repeat(3_000_000)))).rejects.toThrow(
      "RPC writer queue is full",
    );
    await expect(Promise.all(writes)).rejects.toThrow();
    expect(closed).toBe(true);
    expect(sink.destroyed).toBe(true);
    await expect(writer.write(notification("later"))).rejects.toThrow("writer is closed");
  });
});
