import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { HarnessClient, type RpcConnection } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { serverStopRequest, serverReleaseRequest, type ServerIdentity } from "./contracts.ts";
import { forwardBridgeInput } from "./bridge-input.ts";
import {
  canonicalHome,
  connectDiscovered,
  privateRuntimeDirectory,
  readDiscovery,
  sameHome,
  type ServerDiscovery,
} from "./local.ts";

/** Execute the owner directly: its process PID is the published identity PID. */
export interface ServerLaunch {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
export interface HostConnection {
  connection: RpcConnection;
  identity: ServerIdentity;
  socket: Socket;
  close(): void;
}

async function attachDiscovered(
  home: string,
  discovery: ServerDiscovery,
  signal?: AbortSignal,
): Promise<HostConnection> {
  const { socket, identity } = await connectDiscovered(home, discovery, signal);
  const connection = createNdjsonMessageConnection(socket, socket);
  return {
    identity,
    socket,
    connection,
    close: () => {
      connection.dispose();
      socket.destroy();
    },
  };
}

export async function attachLocalServer(
  requestedHome: string,
  signal?: AbortSignal,
): Promise<HostConnection> {
  signal?.throwIfAborted();
  const home = await canonicalHome(requestedHome);
  const discovery = await readDiscovery(home);
  if (discovery === null) throw new Error("Server discovery is unavailable; reconnect explicitly");
  return attachDiscovered(home, discovery, signal);
}

const unavailable = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ECONNREFUSED";

/** SQLite arbitrates ownership; only its classified contention exit permits another attempt. */
export async function ensureLocalServer(
  requestedHome: string,
  launch: ServerLaunch,
  signal?: AbortSignal,
): Promise<HostConnection> {
  signal?.throwIfAborted();
  const home = await canonicalHome(requestedHome);
  const directory = await privateRuntimeDirectory(home);
  const existing = await readDiscovery(home);
  if (existing !== null) {
    try {
      return await attachDiscovered(home, existing, signal);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  let exited: number | null | undefined;
  let childError: Error | undefined;
  let candidate: { child: ChildProcess; closed: Promise<void> } | undefined;
  let attempts = 0;
  const start = async () => {
    signal?.throwIfAborted();
    const log = await open(join(directory, "startup.log"), "a", 0o600);
    exited = undefined;
    attempts++;
    try {
      signal?.throwIfAborted();
      const child = spawn(launch.executable, launch.args, {
        env: { ...process.env, ...launch.env, HARNESS_HOME: home },
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
        windowsHide: true,
      });
      candidate = {
        child,
        closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
      };
      child.once("error", (error) => {
        childError = error;
      });
      child.once("exit", (code) => {
        exited = code;
      });
      child.unref();
    } finally {
      await log.close();
    }
  };
  const deadline = Date.now() + 20_000;
  await start();
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (childError !== undefined) throw childError;
    if (exited !== undefined && exited !== 76)
      throw new Error(
        `Server startup failed (exit ${String(exited)}); see ${join(directory, "startup.log")}`,
      );
    const discovery = await readDiscovery(home);
    if (discovery !== null) {
      try {
        const host = await attachDiscovered(home, discovery, signal);
        try {
          signal?.throwIfAborted();
          if (candidate !== undefined && candidate.child.pid !== host.identity.pid) {
            // Successful owner selection supersedes our own pending launch. Join
            // it before returning, so it cannot claim SQLite after that owner stops.
            if (exited === undefined) candidate.child.kill("SIGKILL");
            if (childError !== undefined)
              throw new Error("Failed to retire superseded Local startup candidate", {
                cause: childError,
              });
            const completed = new AbortController();
            try {
              await Promise.race([
                candidate.closed,
                delay(Math.max(0, deadline - Date.now()), undefined, {
                  signal:
                    signal === undefined
                      ? completed.signal
                      : AbortSignal.any([signal, completed.signal]),
                  ref: false,
                }).then(() => {
                  throw new Error(
                    "Superseded Local startup candidate did not exit within startup window",
                  );
                }),
              ]);
            } finally {
              completed.abort();
            }
            if (childError !== undefined)
              throw new Error("Failed to retire superseded Local startup candidate", {
                cause: childError,
              });
          }
          signal?.throwIfAborted();
          return host;
        } catch (error) {
          host.close();
          throw error;
        }
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    // Two new SQLite openers may both lose their SHARED -> EXCLUSIVE upgrade.
    // Stagger only this classified failure, with finite starts and readiness time.
    if (exited === 76 && attempts < 8) {
      await delay(randomInt(50, 201), undefined, { signal });
      await start();
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`Server did not become ready; see ${join(directory, "startup.log")}`);
}

/** A bridge has no execution ownership. EOF only closes its authenticated socket. */
export async function runLocalBridge(
  home: string,
  launch?: ServerLaunch,
  onConnected?: (identity: ServerIdentity) => void,
): Promise<void> {
  const attempt = new AbortController();
  let host: HostConnection | undefined;
  let inputEnded = false;
  // Start observing EOF before readiness. A tiny high-water mark holds early
  // protocol input behind the existing bounded writer queue until attachment.
  const input = new PassThrough({ highWaterMark: 1 });
  const disposeInput = forwardBridgeInput(
    input,
    () => {
      inputEnded = true;
      attempt.abort();
      host?.close();
    },
    (error) => {
      attempt.abort(error);
      host?.socket.destroy(error);
    },
  );
  if (process.stdin.readableEnded) {
    inputEnded = true;
    attempt.abort();
  }
  try {
    host = launch
      ? await ensureLocalServer(home, launch, attempt.signal)
      : await attachLocalServer(home, attempt.signal);
    attempt.signal.throwIfAborted();
    onConnected?.(host.identity);
    const socket = host.socket;
    socket.pipe(process.stdout);
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", failed);
      process.stdout.once("error", failed);
      socket.once("close", () => resolve());
      // EOF abandons unacknowledged transport delivery; accepted work belongs to
      // the server. Never wait for a frozen owner to flush or acknowledge bytes.
      input.pipe(socket);
    });
  } catch (error) {
    if (!inputEnded) throw error;
  } finally {
    disposeInput();
    input.destroy();
    host?.socket.unpipe(process.stdout);
    host?.close();
  }
}

/** Use an independent control connection, so an initialized GUI/TUI peer is untouched. */
export async function stopServer(identity: ServerIdentity, ifAlone = false): Promise<void> {
  const discovery = await readDiscovery(identity.home);
  if (discovery === null)
    throw new Error("Server discovery is unavailable; shutdown outcome is unknown");
  if (
    !sameHome(discovery.home, identity.home) ||
    discovery.instanceId !== identity.instanceId ||
    discovery.serverId !== identity.serverId
  )
    throw new Error("Server instance changed; reconnect before stopping it");
  const host = await attachDiscovered(identity.home, discovery);
  const client = new HarnessClient({
    connection: host.connection,
    client: { name: "harness-control", version: "0.0.0" },
  });
  const closed = new Promise<void>((resolve) => host.connection.onClose(() => resolve()));
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Server shutdown did not finish within 20 seconds")),
      20_000,
    );
  });
  try {
    await Promise.race([
      deadline,
      (async () => {
        await client.start();
        if (ifAlone) {
          const result = await client.peer.request(serverReleaseRequest, {});
          if (!result.stopping) return;
        } else await client.peer.request(serverStopRequest, {});
        await closed;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    client.peer.close();
    host.close();
  }
}
