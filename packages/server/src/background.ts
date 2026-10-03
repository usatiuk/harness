import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { z } from "zod";
import { defaultHome } from "@harness/config";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { serverIdentitySchema, serverInfoRequest, serverStopRequest } from "@harness/connections";
import {
  authenticateSocket,
  canonicalHome,
  createServerToken,
  privateRuntimeDirectory,
  replaceJson,
  serverSecretStore,
} from "@harness/connections/local";
import { buildServerComposition } from "./index.ts";

/** The SQLite owner alone publishes or removes discovery. Network peers only observe it. */
export async function runBackgroundServer(): Promise<void> {
  const home = await canonicalHome(defaultHome());
  process.env["HARNESS_HOME"] = home;
  const composition = await buildServerComposition();
  const sockets = new Set<Socket>();
  let stopping = false;
  let listenerFailure: Error | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const listener = createServer();
  const fail = (error: Error) => {
    listenerFailure = error;
    console.error(JSON.stringify({ event: "server.listener.failed", message: error.message }));
    stop();
  };
  const signal = () => stop();
  let published: string | undefined;
  try {
    const directory = await privateRuntimeDirectory(home);
    const identityPath = join(directory, "identity.json");
    let serverId: string;
    try {
      const value: unknown = JSON.parse(await readFile(identityPath, "utf8"));
      serverId = z.strictObject({ serverId: z.uuid() }).parse(value).serverId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      serverId = randomUUID();
      await replaceJson(identityPath, { serverId });
    }
    const identity = serverIdentitySchema.parse({
      serverId,
      instanceId: randomUUID(),
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      home,
      pid: process.pid,
      platform: process.platform,
      buildId: process.env["HARNESS_BUILD_ID"] ?? "development",
    });
    const identityFrame = `${JSON.stringify(identity)}\n`;
    if (Buffer.byteLength(identityFrame) > 4096)
      throw new Error("Server identity exceeds authentication frame limit");
    const token = createServerToken();
    await serverSecretStore(directory).set("token", token);
    const expected = Buffer.from(token);
    listener.on("connection", (socket) => {
      if (stopping || sockets.size >= 64) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Authentication failures are classified external failures, before any RPC admission.
      void authenticateSocket(socket).then(
        (supplied) => {
          const actual = Buffer.from(supplied);
          if (stopping || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            socket.destroy();
            return;
          }
          try {
            socket.write(identityFrame);
            const session = composition.connect(createNdjsonMessageConnection(socket, socket));
            session.onRequest(serverInfoRequest, () => identity);
            session.onRequest(serverStopRequest, () => {
              // Shutdown cannot await the request that admitted it. Return acceptance first.
              setImmediate(stop);
              return { accepted: true as const };
            });
          } catch (error) {
            socket.destroy();
            fail(
              error instanceof Error ? error : new Error("RPC admission failed", { cause: error }),
            );
          }
        },
        () => {
          // Never amplify unauthenticated traffic into an unbounded diagnostic log.
          socket.destroy();
        },
      );
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    listener.on("error", fail);
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("Background server did not bind TCP");
    published = join(directory, "discovery.json");
    await replaceJson(published, { ...identity, port: address.port });
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    await stopped;
    if (listenerFailure !== undefined) throw listenerFailure;
  } finally {
    stopping = true;
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    // Remove our record while SQLite is still exclusively held. A successor cannot
    // publish yet, so an old process can never unlink its successor's discovery.
    const closed = listener.listening
      ? new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
    try {
      if (published !== undefined) await rm(published, { force: true });
    } finally {
      try {
        await composition.close();
      } finally {
        for (const socket of sockets) socket.destroy();
        await closed;
      }
    }
  }
}
