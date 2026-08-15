import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc";
import type { DataCallback, Disposable, Message, MessageConnection } from "vscode-jsonrpc";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_WRITER_QUEUE_BYTES } from "@harness/protocol";

interface QueuedMessage {
  message: Message;
  bytes: number;
}

class InProcessReader extends AbstractMessageReader {
  private callback: DataCallback | undefined;
  private readonly queued: QueuedMessage[] = [];
  private queuedBytes = 0;
  private closed = false;

  listen(callback: DataCallback): Disposable {
    if (this.callback !== undefined) {
      throw new Error("in-process reader is already listening");
    }
    this.callback = callback;
    this.flush();
    return { dispose: () => (this.callback = undefined) };
  }

  accept(message: Message, bytes: number): void {
    if (this.closed) {
      throw new Error("in-process transport is closed");
    }
    if (this.queuedBytes + bytes > MAX_RPC_WRITER_QUEUE_BYTES) {
      throw new Error("RPC writer queue is full");
    }
    this.queued.push({ message, bytes });
    this.queuedBytes += bytes;
    queueMicrotask(() => this.flush());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fireClose();
  }

  private flush(): void {
    while (!this.closed && this.callback !== undefined && this.queued.length > 0) {
      const next = this.queued.shift()!;
      this.queuedBytes -= next.bytes;
      this.callback(next.message);
    }
  }
}

class InProcessWriter extends AbstractMessageWriter {
  private ended = false;

  constructor(private readonly target: InProcessReader) {
    super();
  }

  async write(message: Message): Promise<void> {
    if (this.ended) {
      throw new Error("in-process transport is closed");
    }

    // Local and remote connections must observe the same JSON value semantics.
    const encoded = JSON.stringify(message);
    if (encoded === undefined) {
      throw new Error("JSON-RPC message is not JSON serializable");
    }
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > MAX_RPC_FRAME_BYTES) {
      const error = new Error("RPC frame is too large");
      this.fail(error);
      throw error;
    }
    try {
      this.target.accept(JSON.parse(encoded) as Message, bytes);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.target.close();
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.fireError(error);
    this.fireClose();
    this.target.close();
  }
}

export interface InProcessMessageConnectionPair {
  readonly left: MessageConnection;
  readonly right: MessageConnection;
}

export const createInProcessMessageConnectionPair = (): InProcessMessageConnectionPair => {
  const leftReader = new InProcessReader();
  const rightReader = new InProcessReader();
  return {
    left: createMessageConnection(leftReader, new InProcessWriter(rightReader)),
    right: createMessageConnection(rightReader, new InProcessWriter(leftReader)),
  };
};
