import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BUILD_IDENTITY } from "@harness/release";
import { basename } from "node:path";
import {
  serverCacheEntrySchema,
  ensureLocalServer,
  preparedServerSchema,
  withServerLifecycle,
  selectInitialServer,
  readDiscovery,
  connectDiscovered,
  type ServerLaunch,
} from "@harness/connections/node";
import { defaultHome } from "@harness/config";
import { PRODUCT_VERSION } from "@harness/release";
import type { z } from "zod";
import { CacheUse } from "@harness/native";

export interface PreparedServerLaunch {
  launch: ServerLaunch;
  close(): Promise<void>;
}

/** An isolated server must not replace a live shared owner's source selection. */
export async function selectStdioServer(launch: ServerLaunch): Promise<void> {
  const selection = launch.selection;
  if (selection === undefined) return;
  await withServerLifecycle(defaultHome(), async (home) => {
    const discovered = await readDiscovery(home);
    if (discovered !== null) {
      let live;
      try {
        live = await connectDiscovered(home, discovered);
      } catch (error) {
        if (!["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      if (live !== undefined) {
        live.socket.destroy();
        throw new Error(
          "A shared Local server is running; stop it before starting an isolated stdio server",
        );
      }
    }
    await selectInitialServer(home, selection);
  });
}

/** The native helper retains signed paths and use guards until explicit EOF. */
export async function prepareServerLaunch(
  mode: "stdio" | "background",
  signal?: AbortSignal,
): Promise<PreparedServerLaunch> {
  signal?.throwIfAborted();
  const developmentPayload =
    BUILD_IDENTITY.mode === "development"
      ? process.env["HARNESS_DEVELOPMENT_SERVER_PAYLOAD"]
      : undefined;
  if (BUILD_IDENTITY.mode === "development" && developmentPayload === undefined)
    return { launch: localServerLaunch(mode), close: async () => {} };
  const launcher = process.env["HARNESS_NATIVE_LAUNCHER"];
  if (!launcher) throw new Error("The installed CLI has no native bootstrap launcher");
  const home = defaultHome();
  const child = spawn(
    launcher,
    developmentPayload === undefined
      ? ["--prepare-server", PRODUCT_VERSION]
      : ["--prepare-development-server", developmentPayload],
    {
      env: { ...process.env, HARNESS_HOME: home },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  let retirementRequested = false;
  let unexpectedExit = false;
  child.once("exit", () => {
    unexpectedExit = !retirementRequested;
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const cancel = () => child.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      retirementRequested = true;
      child.stdin.end();
      const code = await exited;
      signal?.removeEventListener("abort", cancel);
      if (code !== 0 || unexpectedExit)
        throw new Error(`Server preparation failed: ${diagnostic}`, { cause: spawnError });
    })());
  try {
    const value = await new Promise<z.infer<typeof preparedServerSchema>>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const data = (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 16_384) {
          reject(new Error("Server preparation descriptor exceeds its limit"));
          child.kill();
          return;
        }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        child.stdout.off("data", data);
        try {
          resolve(preparedServerSchema.parse(JSON.parse(bytes.subarray(0, newline).toString())));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Invalid server preparation descriptor", { cause: error }),
          );
          child.kill();
        }
      };
      child.stdout.on("data", data);
      child.once("close", () =>
        reject(
          new Error(`Server preparation ended before readiness: ${diagnostic}`, {
            cause: spawnError,
          }),
        ),
      );
    });
    signal?.throwIfAborted();
    signal?.removeEventListener("abort", cancel);
    const selection = serverCacheEntrySchema.parse(basename(value.payload));
    return {
      launch: {
        executable: value.node,
        args: [value.entry, `--${mode}`],
        selection,
        retainUse: () => new CacheUse(home, value.keys),
        env: {
          HARNESS_NATIVE_BINDING: undefined,
          HARNESS_SERVER_SELECTION: selection,
          HARNESS_SERVER_CACHE_KEYS: JSON.stringify(value.keys),
        },
      },
      close,
    };
  } catch (error) {
    child.kill();
    await exited;
    signal?.removeEventListener("abort", cancel);
    signal?.throwIfAborted();
    throw error;
  }
}

/** Installed launchers supply verified immutable paths; source runs use workspace exports. */
export function localServerLaunch(mode: "stdio" | "background"): ServerLaunch {
  const entry = process.env["HARNESS_SERVER_ENTRY"];
  if (entry) {
    const payload = process.env["HARNESS_SERVER_PAYLOAD"];
    if (!payload) throw new Error("The installed launcher did not capture its server payload");
    const node = process.env["HARNESS_SERVER_NODE"];
    if (!node) throw new Error("The installed launcher did not capture its server runtime");
    const selection = serverCacheEntrySchema.parse(basename(payload));
    return {
      executable: node,
      args: [entry, `--${mode}`],
      selection,
      env: { HARNESS_SERVER_SELECTION: selection },
    };
  }
  if (BUILD_IDENTITY.mode === "release")
    throw new Error("The installed launcher did not prepare its server payload");
  return {
    executable: process.execPath,
    args: [
      ...process.execArgv,
      fileURLToPath(import.meta.resolve("@harness/server/entry")),
      `--${mode}`,
    ],
    env: { HARNESS_SERVER_SELECTION: undefined },
  };
}

/** A terminal server command owns its prepared child until physical exit. */
export async function runServerCommand(mode: "stdio" | "background"): Promise<void> {
  const prepared = await prepareServerLaunch(mode);
  const { launch } = prepared;
  if (mode === "background") {
    try {
      const server = await ensureLocalServer(defaultHome(), launch);
      server.close();
    } finally {
      await prepared.close();
    }
    return;
  }
  let usage: { close(): void } | undefined;
  try {
    usage = launch.retainUse?.();
    await selectStdioServer(launch);
    const child = spawn(launch.executable, launch.args, {
      stdio: "inherit",
      env: { ...process.env, ...launch.env },
      windowsHide: true,
    });
    // Ctrl+C reaches both processes in the foreground console/group. Keep the
    // CLI alive while its server performs shutdown; explicitly forward SIGTERM.
    const interrupt = () => {};
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      let failure: Error | undefined;
      child.once("error", (error) => {
        failure = error;
      });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      if (failure) throw failure;
      process.exitCode = code ?? 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    usage?.close();
    await prepared.close();
  }
}
