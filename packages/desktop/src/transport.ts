import {
  parseConnectionCommandResult,
  type HostConnectionTarget,
  type ConnectionCommand,
  type ConnectionCommandResult,
} from "@harness/connections";
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
  | { type: "started"; id: number }
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
    private readonly close: (error?: Error) => void,
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
      this.close(error);
      throw error;
    }
    this.bytes += bytes;
    const result = this.tail.then(() => {
      if (this.ended) throw new Error("Desktop transport is closed");
      return invoke<void>("server_write", { id: this.id, frame });
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      await result;
    } catch (cause) {
      const error = new Error("Could not write to the Harness server", { cause });
      this.fireError(error);
      this.close(error);
      throw error;
    } finally {
      this.bytes -= bytes;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.close();
  }
}

export async function connectNative(
  target: HostConnectionTarget,
  onClosed: (message: string) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const reader = new NativeReader();
  let writer: NativeWriter | undefined = undefined;
  let resolveId!: (id: number | undefined) => void;
  const ready = new Promise<number | undefined>((resolve) => {
    resolveId = resolve;
  });
  let closing: Promise<void> | undefined;
  let closedMessage: string | undefined;
  let operationId: number | undefined;
  let canceling: Promise<void> | undefined;
  let cancellationError: Error | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = ready.then(async (id) => {
        if (id !== undefined) await invoke<void>("server_disconnect", { id });
      });
      void closing.catch(() => onClosed("Could not detach the native Harness bridge"));
      writer?.end();
      reader.close();
    }
    return closing;
  };
  const fail = (error?: Error): void => {
    if (closing) return;
    if (error) {
      closedMessage = error.message;
      reader.close(error);
      onClosed(error.message);
    }
    void close();
  };
  const cancel = (): void => {
    if (operationId !== undefined && !canceling) {
      canceling = invoke<void>("cancel_connection_command", { id: operationId }).catch(
        (cause: unknown) => {
          cancellationError = new Error("Could not cancel the native connection attempt", {
            cause,
          });
        },
      );
    }
    void close();
  };
  const channel = new Channel<ServerEvent>();
  channel.onmessage = (event) => {
    if (event.type === "started") {
      operationId = event.id;
      if (signal?.aborted) cancel();
      return;
    }
    if (closing) return;
    if (event.type === "closed") {
      fail(new Error(event.message));
    } else {
      try {
        reader.receive(event.frame);
        if (!closing)
          void invoke("server_ack", { id: event.id }).catch(() => {
            fail(new Error("Desktop stream acknowledgement failed"));
          });
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid data from the Harness server"));
      }
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let admission: { id: number } | { error: unknown };
  try {
    const id = await invoke<number>("server_connect", { channel, ...target });
    resolveId(id);
    admission = { id };
  } catch (error) {
    resolveId(undefined);
    admission = { error };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  await canceling;
  if (cancellationError || "error" in admission || signal?.aborted || closing) {
    await close();
    if (cancellationError) throw cancellationError;
    signal?.throwIfAborted();
    if ("error" in admission) throw admission.error;
    throw new Error(closedMessage ?? "Harness bridge closed during connection");
  }
  writer = new NativeWriter(fail, admission.id);
  const connection = createMessageConnection(reader, writer);
  connection.onDispose(() => void close());
  return { connection, close };
}
export async function connectionCommand<C extends ConnectionCommand>(
  command: C,
  progress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<ConnectionCommandResult<C>> {
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
  return parseConnectionCommandResult(command, result);
}
