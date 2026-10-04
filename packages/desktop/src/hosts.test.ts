import { afterEach, expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair, type RpcConnection } from "@harness/client";
import { defaultClientConfig } from "@harness/connections";
import { DesktopHosts } from "./hosts.ts";

const native = vi.hoisted(() => ({
  command: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./transport.ts", () => ({
  connectionCommand: native.command,
  connectNative: native.connect,
  disconnectNative: native.disconnect,
}));
const connections: RpcConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function stalledPeer() {
  const pair = createInProcessMessageConnectionPair();
  connections.push(pair.left, pair.right);
  let connected!: () => void;
  const started = new Promise<void>((resolve) => {
    connected = resolve;
  });
  native.command.mockResolvedValue(defaultClientConfig());
  native.connect.mockImplementation(
    async (_host, _runtime, onClosed: (message: string) => void) => {
      native.disconnect.mockImplementation(async () => {
        onClosed("Harness server disconnected");
        pair.right.dispose();
      });
      connected();
      return { connection: pair.left, id: 1 };
    },
  );
  return started;
}

it("disconnect cancels a desktop peer that never initializes", async () => {
  const started = stalledPeer();
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await started;
  await hosts.disconnect("local");
  await loading;
  expect(hosts.selected?.session).toBeUndefined();
  expect(hosts.selected?.progress).toBeUndefined();
});

it("readiness expiry closes the stalled peer and reports the deadline", async () => {
  const started = stalledPeer();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const hosts = new DesktopHosts();
  const loading = hosts.initialize();
  await started;
  deadline.abort(new DOMException("Connection readiness timed out", "TimeoutError"));
  await loading;
  expect(hosts.selected?.error).toBe("Connection readiness timed out");
  expect(hosts.selected?.session).toBeUndefined();
  expect(hosts.selected?.progress).toBeUndefined();
});
