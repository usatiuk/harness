import { afterEach, expect, it, vi } from "vitest";
import { HarnessClient } from "@harness/client";
import { HARNESS_PROTOCOL_VERSION, MAX_RPC_FRAME_BYTES } from "@harness/protocol";
import { LOCAL_HOST } from "@harness/connections";
import { connectNative } from "./transport.ts";

interface NativeArgs {
  channel?: { onmessage(event: unknown): void };
  id?: number;
  frame?: string;
}
const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args: NativeArgs) => Promise<unknown>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

function fixture() {
  const observers = new Set<number>();
  const detached: number[] = [];
  let channel: { onmessage(event: unknown): void };
  const emit = (frame: string) => channel.onmessage({ type: "message", id: 1, frame });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "server_connect") {
      channel = args.channel!;
      observers.add(1);
      return 1;
    }
    if (command === "server_disconnect") {
      observers.delete(args.id!);
      detached.push(args.id!);
    }
    if (command === "server_write") {
      const message = JSON.parse(args.frame!) as { method?: string; id?: number };
      if (message.method === "initialize")
        queueMicrotask(() =>
          emit(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: HARNESS_PROTOCOL_VERSION,
                server: { name: "fixture", version: "1" },
                plugins: [],
              },
            }),
          ),
        );
    }
  });
  return { observers, detached, emit };
}
afterEach(() => vi.resetAllMocks());

it("RPC closure and manager teardown detach the same native observer exactly once", async () => {
  const owner = fixture();
  const transport = await connectNative({ host: LOCAL_HOST, runtime: null }, vi.fn());
  const client = new HarnessClient({
    connection: transport.connection,
    client: { name: "test", version: "1" },
  });
  await client.start();
  client.closeConnection();
  await transport.close();
  await transport.close();
  expect(owner.observers.size).toBe(0);
  expect(owner.detached).toEqual([1]);
});

it.each(["protocol", "malformed", "oversized", "write-limit", "write", "ack"])(
  "%s failure releases the physical observer and stops crediting discarded frames",
  async (failure) => {
    const owner = fixture();
    const transport = await connectNative({ host: LOCAL_HOST, runtime: null }, vi.fn());
    const client = new HarnessClient({
      connection: transport.connection,
      client: { name: "test", version: "1" },
    });
    await client.start();
    const invoke = native.invoke.getMockImplementation()!;
    let acknowledgements = 0;
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "server_ack") acknowledgements++;
      if (command === `server_${failure}`) throw new Error("Fixture I/O failure");
      return invoke(command, args);
    });
    if (failure === "write" || failure === "write-limit")
      await expect(
        transport.connection.sendNotification("fixture", {
          body: failure === "write-limit" ? "x".repeat(MAX_RPC_FRAME_BYTES) : "small",
        }),
      ).rejects.toThrow();
    else
      owner.emit(
        failure === "malformed"
          ? "{"
          : failure === "oversized"
            ? "x".repeat(MAX_RPC_FRAME_BYTES + 1)
            : JSON.stringify({
                jsonrpc: "2.0",
                method: failure === "ack" ? "fixture" : "conversation.event",
                params: {},
              }),
      );
    await vi.waitFor(() => expect(client.peer.ready).toBe(false));
    await transport.close();
    const credited = acknowledgements;
    owner.emit(JSON.stringify({ jsonrpc: "2.0", method: "fixture", params: {} }));
    expect(acknowledgements).toBe(credited);
    expect(owner.observers.size).toBe(0);
    expect(owner.detached).toEqual([1]);
  },
);

it("failure before native admission returns still detaches the admitted bridge", async () => {
  const owner = fixture();
  const invoke = native.invoke.getMockImplementation()!;
  let admit!: () => void;
  const ready = new Promise<void>((resolve) => {
    admit = resolve;
  });
  native.invoke.mockImplementation(async (command, args) => {
    const result = await invoke(command, args);
    if (command === "server_connect") await ready;
    return result;
  });
  const connecting = connectNative({ host: LOCAL_HOST, runtime: null }, vi.fn());
  const rejected = expect(connecting).rejects.toThrow();
  owner.emit("{");
  admit();
  await rejected;
  expect(owner.observers.size).toBe(0);
  expect(owner.detached).toEqual([1]);
});

it("reports physical teardown failure instead of hiding it behind logical closure", async () => {
  fixture();
  const invoke = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "server_disconnect") throw new Error("Fixture detach failure");
    return invoke(command, args);
  });
  const onClosed = vi.fn();
  const transport = await connectNative({ host: LOCAL_HOST, runtime: null }, onClosed);
  await expect(transport.close()).rejects.toThrow("Fixture detach failure");
  expect(onClosed).toHaveBeenCalledWith("Could not detach the native Harness bridge");
});

it.each(["before", "after"])(
  "cancels preparation when aborted %s the native operation ID arrives and awaits retirement",
  async (timing) => {
    const abort = new AbortController();
    let channel!: NonNullable<NativeArgs["channel"]>;
    let retire!: () => void;
    const retired = new Promise<void>((resolve) => {
      retire = resolve;
    });
    let cancelRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      cancelRequested = resolve;
    });
    const detached: number[] = [];
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "server_connect") {
        channel = args.channel!;
        if (timing === "after") channel.onmessage({ type: "started", id: 42 });
        await retired;
        throw new Error("Connection attempt cancelled");
      }
      if (command === "cancel_connection_command") {
        expect(args.id).toBe(42);
        cancelRequested();
      }
      if (command === "server_disconnect") detached.push(args.id!);
    });
    const connecting = connectNative({ host: LOCAL_HOST, runtime: null }, vi.fn(), abort.signal);
    const rejected = expect(connecting).rejects.toThrow();
    let settled = false;
    void connecting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    abort.abort();
    if (timing === "before") channel.onmessage({ type: "started", id: 42 });
    await requested;
    expect(settled).toBe(false);
    retire();
    await rejected;
    expect(detached).toEqual([]);
  },
);

it.each([false, true])(
  "an aborted late admission detaches before returning, including cancellation error=%s",
  async (cancelFails) => {
    const owner = fixture();
    const invoke = native.invoke.getMockImplementation()!;
    const abort = new AbortController();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "cancel_connection_command" && cancelFails)
        throw new Error("Fixture cancel command failed");
      const result = await invoke(command, args);
      if (command === "server_connect") {
        args.channel!.onmessage({ type: "started", id: 1 });
        await admitted;
      }
      return result;
    });
    const connecting = connectNative({ host: LOCAL_HOST, runtime: null }, vi.fn(), abort.signal);
    const rejected = expect(connecting).rejects.toThrow(
      cancelFails ? "Could not cancel the native connection attempt" : undefined,
    );
    await vi.waitFor(() => expect(owner.observers.size).toBe(1));
    abort.abort();
    admit();
    await rejected;
    expect(owner.detached).toEqual([1]);
    expect(owner.observers.size).toBe(0);
  },
);
