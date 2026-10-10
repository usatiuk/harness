import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultHome } from "@harness/config";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { PRODUCT_VERSION } from "@harness/release";
import { ResponseError, ErrorCodes } from "vscode-jsonrpc";
import { createNdjsonTransport, type NdjsonTransport } from "@harness/client/node";
import {
  serverIdentitySchema,
  serverInfoRequest,
  serverStopRequest,
  serverReleaseRequest,
  managementInspectRequest,
  managementStopRequest,
  managementReleaseRequest,
} from "@harness/connections";
import {
  authenticateSocket,
  canonicalHome,
  createServerToken,
  privateRuntimeDirectory,
  serverSecretStore,
  listenLocal,
  type LocalListener,
} from "@harness/connections/local";
import { replaceJson } from "@harness/connections/node";
import { buildServerComposition, type ServerComposition } from "./index.ts";

/** The SQLite owner alone publishes or removes discovery. IPC peers only observe it. */
export async function runBackgroundServer(): Promise<void> {
  const home = await canonicalHome(defaultHome());
  process.env["HARNESS_HOME"] = home;
  let composition: ServerComposition | undefined;
  const startup = new AbortController();
  const sockets = new Map<Socket, NdjsonTransport | null>();
  let stopping = false;
  let listenerFailure: Error | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let listener: LocalListener | undefined;
  const fail = (error: Error) => {
    listenerFailure = error;
    console.error(JSON.stringify({ event: "server.listener.failed", message: error.message }));
    stop();
  };
  const signal = () => {
    startup.abort();
    stop();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  let published: string | undefined;
  try {
    composition = await buildServerComposition({ signal: startup.signal });
    const owner = composition;
    const directory = await privateRuntimeDirectory(home);
    const serverDirectory = join(home, "server");
    await mkdir(serverDirectory, { recursive: true, mode: 0o700 });
    const identityPath = join(serverDirectory, "identity.json");
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
      managementVersion: 1,
      productVersion: PRODUCT_VERSION,
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
    listener = await listenLocal(
      home,
      identity.instanceId,
      (socket) => {
        if (stopping || sockets.size >= 64) {
          socket.destroy();
          return;
        }
        sockets.set(socket, null);
        socket.once("close", () => sockets.delete(socket));
        // Authentication failures are classified external failures, before any RPC admission.
        void authenticateSocket(socket).then(
          (supplied) => {
            const actual = Buffer.from(supplied);
            if (
              stopping ||
              actual.length !== expected.length ||
              !timingSafeEqual(actual, expected)
            ) {
              socket.destroy();
              return;
            }
            try {
              socket.write(identityFrame);
              const transport = createNdjsonTransport(socket, socket);
              const session = owner.connect(transport.connection);
              sockets.set(socket, transport);
              // This small management surface is independent of application
              // initialization, including an incompatible application handshake.
              const inspect = managementInspectRequest;
              transport.connection.onRequest(inspect.method, (raw: unknown) => {
                if (!inspect.params.safeParse(raw).success)
                  return new ResponseError(
                    ErrorCodes.InvalidParams,
                    "Invalid management parameters",
                  );
                return identity;
              });
              transport.connection.onRequest(managementStopRequest.method, (raw: unknown) => {
                const params = managementStopRequest.params.safeParse(raw);
                if (!params.success || params.data.instanceId !== identity.instanceId)
                  return new ResponseError(
                    ErrorCodes.InvalidParams,
                    "Server instance changed; reconnect before stopping it",
                  );
                setImmediate(stop);
                return { accepted: true as const };
              });
              transport.connection.onRequest(managementReleaseRequest.method, (raw: unknown) => {
                const params = managementReleaseRequest.params.safeParse(raw);
                if (!params.success || params.data.instanceId !== identity.instanceId)
                  return new ResponseError(
                    ErrorCodes.InvalidParams,
                    "Server instance changed; reconnect before releasing it",
                  );
                if (sockets.size !== 1) return { stopping: false };
                stopping = true;
                setImmediate(stop);
                return { stopping: true };
              });
              session.onRequest(serverInfoRequest, () => identity);
              session.onRequest(serverStopRequest, () => {
                // Shutdown cannot await the request that admitted it. Return acceptance first.
                setImmediate(stop);
                return { accepted: true as const };
              });
              session.onRequest(serverReleaseRequest, () => {
                if (sockets.size !== 1) return { stopping: false };
                stopping = true;
                setImmediate(stop);
                return { stopping: true };
              });
            } catch (error) {
              socket.destroy();
              fail(
                error instanceof Error
                  ? error
                  : new Error("RPC admission failed", { cause: error }),
              );
            }
          },
          () => {
            // Never amplify unauthenticated traffic into an unbounded diagnostic log.
            socket.destroy();
          },
        );
      },
      fail,
    );
    published = join(directory, "discovery.json");
    // SQLite ownership makes any previous record stale. Retire its name before
    // publication: Windows replacement rename can be denied by an ordinary
    // reader of that old file, even though unlink preserves the reader's handle.
    await rm(published, { force: true });
    await replaceJson(published, { ...identity, endpoint: listener.endpoint });
    await stopped;
    if (listenerFailure !== undefined) throw listenerFailure;
  } catch (error) {
    if (!startup.signal.aborted || error !== startup.signal.reason) throw error;
  } finally {
    stopping = true;
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    // Remove our record while SQLite is still exclusively held. A successor cannot
    // publish yet, so an old process can never unlink its successor's discovery.
    const closed = listener?.close() ?? Promise.resolve();
    try {
      if (published !== undefined) await rm(published, { force: true });
    } finally {
      try {
        await composition?.close();
        // Peer closure schedules each writer's end behind accepted RPC responses.
        // Destroying the socket first can discard the Stop acknowledgement.
        const drainage = AbortSignal.timeout(20_000);
        await Promise.all(
          [...sockets].map(async ([socket, connection]) => {
            if (connection === null) {
              socket.destroy();
              return;
            }
            try {
              await connection.drain(drainage);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              // A peer may leave while its output is draining; its RPC transport
              // already observes closure. Other failures still fail shutdown.
              if (
                code !== "ERR_STREAM_PREMATURE_CLOSE" &&
                code !== "ECONNRESET" &&
                code !== "EPIPE"
              )
                throw error;
            }
          }),
        );
      } finally {
        for (const socket of sockets.keys()) socket.destroy();
        await closed;
      }
    }
  }
}
