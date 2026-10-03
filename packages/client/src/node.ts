import type { Readable, Writable } from "node:stream";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc";
import type { DataCallback, Disposable, Message, MessageConnection } from "vscode-jsonrpc";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_WRITER_QUEUE_BYTES } from "@harness/protocol";
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Newline-delimited JSON reader with a hard encoded frame limit. */
export class NdjsonMessageReader extends AbstractMessageReader {
  readonly #source: Readable;
  #callback: DataCallback | undefined;
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(source: Readable) {
    super();
    this.#source = source;
  }

  listen(callback: DataCallback): Disposable {
    if (this.#callback !== undefined) throw new Error("NDJSON reader is already listening");
    this.#callback = callback;
    const onData = (chunk: Buffer | string): void => this.#accept(Buffer.from(chunk));
    const onError = (error: Error): void => this.fireError(error);
    const onClose = (): void => {
      if (!this.#closed && this.#buffer.byteLength > 0) {
        this.fireError(new Error("incomplete RPC frame"));
      }
      this.#close();
    };
    this.#source.on("data", onData);
    this.#source.once("error", onError);
    this.#source.once("end", onClose);
    this.#source.once("close", onClose);
    this.#source.resume();
    return {
      dispose: () => {
        this.#source.off("data", onData);
        this.#source.off("error", onError);
        this.#source.off("end", onClose);
        this.#source.off("close", onClose);
        this.#callback = undefined;
      },
    };
  }

  #accept(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > MAX_RPC_FRAME_BYTES) this.#fail("RPC frame is too large");
        return;
      }
      if (newline > MAX_RPC_FRAME_BYTES) {
        this.#fail("RPC frame is too large");
        return;
      }
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const withoutCr = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
      try {
        if (withoutCr.byteLength === 0) throw new Error("empty RPC frame");
        this.#callback?.(JSON.parse(utf8.decode(withoutCr)) as Message);
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : "invalid RPC frame");
        return;
      }
    }
  }

  #fail(message: string): void {
    this.fireError(new Error(message));
    this.#source.destroy();
    this.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.fireClose();
  }
}

/** Serialized NDJSON writer with hard frame and queued-byte limits. */
export class NdjsonMessageWriter extends AbstractMessageWriter {
  readonly #target: Writable;
  #tail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #ended = false;

  constructor(target: Writable) {
    super();
    this.#target = target;
    target.on("error", (error) => this.#fail(error));
    target.once("close", () => {
      if (!this.#ended) {
        this.#ended = true;
        this.fireClose();
      }
    });
  }

  write(message: Message): Promise<void> {
    if (this.#ended) return Promise.reject(new Error("NDJSON writer is closed"));
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.byteLength - 1 > MAX_RPC_FRAME_BYTES) {
      const error = new Error("RPC frame is too large");
      this.#fail(error);
      return Promise.reject(error);
    }
    if (this.#queuedBytes + frame.byteLength > MAX_RPC_WRITER_QUEUE_BYTES) {
      const error = new Error("RPC writer queue is full");
      this.#fail(error);
      return Promise.reject(error);
    }
    this.#queuedBytes += frame.byteLength;
    const write = this.#tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#target.write(frame, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.#tail = write
      .catch((error: unknown) => {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.#queuedBytes -= frame.byteLength;
      });
    return write;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    void this.#tail.finally(() => this.#target.end());
  }

  #fail(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.fireError(error);
    this.fireClose();
    this.#target.destroy(error);
  }
}

export const createNdjsonMessageConnection = (
  input: Readable,
  output: Writable,
): MessageConnection =>
  createMessageConnection(new NdjsonMessageReader(input), new NdjsonMessageWriter(output));
