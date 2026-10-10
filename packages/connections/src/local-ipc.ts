import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { PipeListener, adoptPipe } from "@harness/native";
import { z } from "zod";

export const localEndpointSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pipe"),
    path: z
      .string()
      .regex(/^\\\\\.\\pipe\\harness-[a-f0-9-]+$/u)
      .max(200),
  }),
  z.strictObject({
    kind: z.literal("socket"),
    path: z
      .string()
      .regex(/^\/(?:private\/)?tmp\/harness-\d+\/[a-f0-9-]+\.sock$/u)
      .refine((path) => Buffer.byteLength(path) < 104),
  }),
]);
export type LocalEndpoint = z.infer<typeof localEndpointSchema>;
export interface LocalListener {
  endpoint: LocalEndpoint;
  /** Stops admission. Completion includes the outstanding native accept. */
  close(): Promise<void>;
}

/** Short, private IPC paths are independent of the user's home path length. */
export async function listenLocal(
  home: string,
  instanceId: string,
  connected: (socket: Socket) => void,
  failed: (error: Error) => void,
): Promise<LocalListener> {
  const key = createHash("sha256").update(home).digest("hex").slice(0, 24);
  if (process.platform === "win32") {
    if (PipeListener === undefined) throw new Error("Windows pipe admission binding is missing");
    const endpoint = localEndpointSchema.parse({
      kind: "pipe",
      path: `\\\\.\\pipe\\harness-${key}-${instanceId}`,
    });
    const listener = new PipeListener(endpoint.path);
    let closing = false;
    const accepting = (async () => {
      try {
        while (!closing) {
          const descriptor = await listener.accept();
          if (descriptor === null) continue;
          const socket = adoptPipe(descriptor);
          if (closing) socket.destroy();
          else connected(socket);
        }
      } catch (error) {
        if (closing && (error as { code?: string }).code === "Cancelled") return;
        failed(
          error instanceof Error ? error : new Error("Pipe admission failed", { cause: error }),
        );
      }
    })();
    let closed: Promise<void> | undefined;
    return {
      endpoint,
      close: () => {
        closing = true;
        closed ??= Promise.all([listener.close(), accepting]).then(() => undefined);
        return closed;
      },
    };
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Unix IPC requires an account UID");
  const directory = `/tmp/harness-${uid}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Harness IPC directory must be owned by this account and private");
  const endpoint = localEndpointSchema.parse({
    kind: "socket",
    path: join(await realpath(directory), `${key}-${instanceId}.sock`),
  });
  const listener = createServer(connected);
  listener.on("error", failed);
  listener.listen(endpoint.path);
  try {
    await once(listener, "listening");
  } catch (error) {
    listener.close();
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    endpoint,
    close: () =>
      (closed ??= new Promise<void>((resolve, reject) => {
        listener.close((error) => {
          // Instance-specific paths can never remove a successor's endpoint.
          void rm(endpoint.path, { force: true }).then(
            () => (error ? reject(error) : resolve()),
            reject,
          );
        });
      })),
  };
}
