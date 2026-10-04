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
