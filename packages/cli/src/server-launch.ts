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
import { CacheUse } from "@harness/native";

export interface PreparedServerLaunch {
  launch: ServerLaunch;
  close(): Promise<void>;
}

/** An isolated server must not replace a live shared owner's selection. */
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

/** Hold the shared cache gate before preparation and until all consumers exit. */
export async function prepareServerLaunch(
  mode: "stdio" | "background",
  signal?: AbortSignal,
): Promise<PreparedServerLaunch> {
  signal?.throwIfAborted();
  if (BUILD_IDENTITY.target === "development")
    return { launch: localServerLaunch(mode), close: async () => {} };
  const launcher = process.env["HARNESS_NATIVE_LAUNCHER"];
  if (!launcher) throw new Error("The installed CLI has no native bootstrap launcher");
  const home = defaultHome();
  const usage = new CacheUse(home);
  try {
    const child = spawn(launcher, ["--prepare-server", PRODUCT_VERSION], {
      env: { ...process.env, HARNESS_HOME: home },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let diagnostic = "";
    let failure: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 16_384) {
        failure = new Error("Server preparation descriptor exceeds its limit");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    child.once("error", (error) => {
      failure = error;
    });
    const cancel = () => child.kill();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    signal?.removeEventListener("abort", cancel);
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0) throw new Error(`Server preparation failed: ${diagnostic}`);
    const value = preparedServerSchema.parse(JSON.parse(output));
    const selection = serverCacheEntrySchema.parse(basename(value.payload));
    return {
      launch: {
        executable: value.node,
        args: [value.entry, `--${mode}`],
        selection,
        retainUse: () => new CacheUse(home),
        env: { HARNESS_NATIVE_BINDING: undefined, HARNESS_SERVER_SELECTION: selection },
      },
      close: async () => usage.close(),
    };
  } catch (error) {
    usage.close();
    throw error;
  }
}

/** Raw source tests use workspace exports; installed clients always prepare immutable paths. */
function localServerLaunch(mode: "stdio" | "background"): ServerLaunch {
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
  try {
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
    await prepared.close();
  }
}
