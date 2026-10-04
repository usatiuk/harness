import type { Host, ConnectionCommand } from "@harness/connections";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
} from "vscode-jsonrpc/browser";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_WRITER_QUEUE_BYTES } from "@harness/protocol";

type ServerEvent =
  | { type: "message"; id: number; frame: string }
  | { type: "closed"; message: string };

class NativeReader extends AbstractMessageReader {
  private callback: DataCallback | undefined;
  private ended = false;
  private readonly queued: Message[] = [];
  private bytes = 0;

  listen(callback: DataCallback): Disposable {
    if (this.callback) throw new Error("Desktop transport is already listening");
    this.callback = callback;
    if (this.ended) queueMicrotask(() => this.fireClose());
    for (const message of this.queued.splice(0)) callback(message);
    this.bytes = 0;
    return {
      dispose: () => {
        this.callback = undefined;
      },
    };
  }

  receive(frame: string): void {
    if (this.ended) return;
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (bytes > MAX_RPC_FRAME_BYTES) throw new Error("Server frame is too large");
    const message = JSON.parse(frame) as Message;
    if (this.callback) this.callback(message);
    else {
      if (this.bytes + bytes > MAX_RPC_WRITER_QUEUE_BYTES)
        throw new Error("Desktop reader queue is full");
      this.bytes += bytes;
      this.queued.push(message);
    }
  }

  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.queued.length = 0;
    if (error) this.fireError(error);
    this.fireClose();
  }
}

class NativeWriter extends AbstractMessageWriter {
  private tail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private ended = false;
  constructor(
    private readonly reader: NativeReader,
    private readonly id: number,
  ) {
    super();
  }

  async write(message: Message): Promise<void> {
    if (this.ended) throw new Error("Desktop transport is closed");
    const frame = JSON.stringify(message);
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (bytes > MAX_RPC_FRAME_BYTES || this.bytes + bytes > MAX_RPC_WRITER_QUEUE_BYTES) {
      const error = new Error("Desktop protocol writer limit exceeded");
      this.reader.close(error);
      throw error;
    }
    this.bytes += bytes;
    const result = this.tail.then(() => invoke<void>("server_write", { id: this.id, frame }));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      await result;
    } catch (cause) {
      const error = new Error("Could not write to the Harness server", { cause });
      this.fireError(error);
      this.reader.close(error);
      throw error;
    } finally {
      this.bytes -= bytes;
    }
  }

  end(): void {
    this.ended = true;
    this.reader.close();
  }
}

export async function connectNative(
  host: Host,
  runtime: unknown,
  onClosed: (message: string) => void,
) {
  const reader = new NativeReader();
  const channel = new Channel<ServerEvent>();
  channel.onmessage = (event) => {
    if (event.type === "closed") {
      onClosed(event.message);
      reader.close(new Error(event.message));
    } else {
      try {
        reader.receive(event.frame);
        void invoke("server_ack", { id: event.id }).catch(() => {
          reader.close(new Error("Desktop stream acknowledgement failed"));
        });
      } catch (error) {
        reader.close(error instanceof Error ? error : new Error(String(error)));
        onClosed("Invalid data from the Harness server");
      }
    }
  };
  const id = await invoke<number>("server_connect", { channel, host, runtime });
  const connection = createMessageConnection(reader, new NativeWriter(reader, id));
  return { connection, id };
}

export async function disconnectNative(id: number): Promise<void> {
  await invoke("server_disconnect", { id });
}
export async function connectionCommand(
  command: ConnectionCommand,
  progress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  let id: number | undefined;
  let canceling: Promise<void> | undefined;
  let cancellationError: Error | undefined;
  const cancel = () => {
    if (id === undefined || canceling) return;
    canceling = invoke<void>("cancel_connection_command", { id }).catch((error: unknown) => {
      cancellationError = new Error("Could not cancel the connection attempt", { cause: error });
    });
  };
  const channel = new Channel<
    { type: "started"; id: number } | { type: "progress"; message: string }
  >();
  channel.onmessage = (event) => {
    if (event.type === "progress") progress?.(event.message);
    else {
      id = event.id;
      if (signal?.aborted) cancel();
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let result: unknown;
  let failure: unknown;
  try {
    result = await invoke("connection_command", { command, channel });
  } catch (error) {
    failure = error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await canceling;
  }
  if (cancellationError) throw cancellationError;
  if (failure instanceof Error) throw failure;
  if (failure !== undefined)
    throw new Error(typeof failure === "string" ? failure : "Connection command failed", {
      cause: failure,
    });
  return result;
}
