import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
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

async function attachDiscovered(home: string, discovery: ServerDiscovery): Promise<HostConnection> {
  const { socket, identity } = await connectDiscovered(home, discovery);
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

export async function attachLocalServer(requestedHome: string): Promise<HostConnection> {
  const home = await canonicalHome(requestedHome);
  const discovery = await readDiscovery(home);
  if (discovery === null) throw new Error("Server discovery is unavailable; reconnect explicitly");
  return attachDiscovered(home, discovery);
}

const unavailable = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ECONNREFUSED";

/** SQLite arbitrates ownership; only its classified contention exit permits another attempt. */
export async function ensureLocalServer(
  requestedHome: string,
  launch: ServerLaunch,
): Promise<HostConnection> {
  const home = await canonicalHome(requestedHome);
  const directory = await privateRuntimeDirectory(home);
  const existing = await readDiscovery(home);
  if (existing !== null) {
    try {
      return await attachDiscovered(home, existing);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  let exited: number | null | undefined;
  let spawnError: Error | undefined;
  let attempts = 0;
  const start = async () => {
    const log = await open(join(directory, "startup.log"), "a", 0o600);
    exited = undefined;
    attempts++;
    try {
      const child = spawn(launch.executable, launch.args, {
        env: { ...process.env, ...launch.env, HARNESS_HOME: home },
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
        windowsHide: true,
      });
      child.once("error", (error) => {
        spawnError = error;
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
    if (spawnError !== undefined) throw spawnError;
    if (exited !== undefined && exited !== 76)
      throw new Error(
        `Server startup failed (exit ${String(exited)}); see ${join(directory, "startup.log")}`,
      );
    const discovery = await readDiscovery(home);
    if (discovery !== null) {
      try {
        return await attachDiscovered(home, discovery);
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    // Two new SQLite openers may both lose their SHARED -> EXCLUSIVE upgrade.
    // Stagger only this classified failure, with finite starts and readiness time.
    if (exited === 76 && attempts < 8) {
      await delay(randomInt(50, 201));
      await start();
    }
    await delay(50);
  }
  throw new Error(`Server did not become ready; see ${join(directory, "startup.log")}`);
}

/** A bridge has no execution ownership. EOF only closes its authenticated socket. */
export async function runLocalBridge(
  home: string,
  launch?: ServerLaunch,
  onConnected?: (identity: ServerIdentity) => void,
): Promise<void> {
  const host = launch ? await ensureLocalServer(home, launch) : await attachLocalServer(home);
  onConnected?.(host.identity);
  const socket = host.socket;
  socket.pipe(process.stdout);
  let disposeInput!: () => void;
  try {
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
      disposeInput = forwardBridgeInput(socket, () => socket.destroy(), failed);
    });
  } finally {
    disposeInput();
    socket.unpipe(process.stdout);
    host.close();
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
