import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { RpcConnection } from "@harness/client";
import { compareVersions } from "@harness/release";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { type ServerIdentity } from "./contracts.ts";
import { stopConnection } from "./control.ts";
import { forwardBridgeInput } from "./bridge-input.ts";
import { withServerLifecycle } from "./lifecycle.ts";
import { selectInitialServer, serverReleaseVersion } from "./selection.ts";
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
  /** Captured immutable payload protected by the initiating bootstrap. */
  selection?: string;
  /** Protect startup until the child confirms its own use guards or physically closes. */
  retainUse?: () => { close(): void };
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
  ["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "");

/** SQLite arbitrates ownership; only its classified contention exit permits another attempt. */
export async function ensureLocalServer(
  requestedHome: string,
  launch: ServerLaunch,
  signal?: AbortSignal,
): Promise<HostConnection> {
  return withServerLifecycle(
    requestedHome,
    (home) => ensureOwnedServer(home, launch, signal),
    signal,
  );
}

async function ensureOwnedServer(
  home: string,
  launch: ServerLaunch,
  signal?: AbortSignal,
): Promise<HostConnection> {
  signal?.throwIfAborted();
  const directory = await privateRuntimeDirectory(home);
  const existing = await readDiscovery(home);
  if (existing !== null) {
    try {
      const host = await attachDiscovered(home, existing, signal);
      const incoming =
        launch.selection === undefined ? undefined : serverReleaseVersion(launch.selection);
      if (incoming === undefined || compareVersions(host.identity.productVersion, incoming) >= 0)
        return host;
      try {
        await stopConnection(host.connection, host.identity, false, true);
        signal?.throwIfAborted();
      } finally {
        host.close();
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  if (launch.selection !== undefined) await selectInitialServer(home, launch.selection);
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
      const usage = launch.retainUse?.();
      let child: ChildProcess;
      try {
        child = spawn(launch.executable, launch.args, {
          env: {
            ...process.env,
            ...launch.env,
            HARNESS_HOME: home,
            HARNESS_SERVER_SELECTION: launch.selection,
          },
          stdio:
            usage === undefined ? ["ignore", log.fd, log.fd] : ["ignore", log.fd, log.fd, "ipc"],
          detached: true,
          windowsHide: true,
        });
      } catch (error) {
        usage?.close();
        throw error;
      }
      candidate = {
        child,
        closed: new Promise<void>((resolve) =>
          child.once("close", () => {
            usage?.close();
            resolve();
          }),
        ),
      };
      if (usage !== undefined) {
        // The child cannot open SQLite until we accept its guard handoff. A
        // cancelled observer may leave it starting, but cannot drop protection.
        const expiry = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const held = (message: unknown) => {
          if (JSON.stringify(message) !== '{"type":"cache-use-held"}') {
            childError = new Error("Invalid server cache-use handoff");
            child.kill("SIGKILL");
            return;
          }
          child.off("message", held);
          clearTimeout(expiry);
          usage.close();
          child.send({ type: "cache-use-accepted" }, (error: Error | null) => {
            if (error) {
              childError = error;
              child.kill("SIGKILL");
            }
          });
        };
        child.on("message", held);
        child.once("close", () => clearTimeout(expiry));
      }
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
  return withServerLifecycle(identity.home, (home) => {
    if (!sameHome(identity.home, home)) throw new Error("Server belongs to another Harness home");
    return stopOwnedServer(identity, ifAlone);
  });
}

async function stopOwnedServer(identity: ServerIdentity, ifAlone: boolean): Promise<void> {
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
  try {
    await stopConnection(host.connection, identity, ifAlone);
  } finally {
    host.close();
  }
}
