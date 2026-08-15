import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "vscode-jsonrpc";
import { MAX_RPC_FRAME_BYTES } from "@harness/protocol";
import { NdjsonMessageReader, NdjsonMessageWriter } from "./node.ts";

const notification = (method: string, params?: unknown): Message =>
  ({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) as Message;

describe("NDJSON transport", () => {
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
