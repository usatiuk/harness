import { runStdioServer } from "./index.ts";
import { runBackgroundServer } from "./background.ts";
import { hostConnectionTargetSchema, connectionCommandSchema } from "@harness/connections";
import {
  runRemoteBridge,
  runConnectionCommand,
  runLocalBridge,
  prepareLocalRuntime,
  serverCacheEntrySchema,
  preparedServerSchema,
} from "@harness/connections/node";
import { dirname } from "node:path";
import { defaultHome } from "@harness/config";
import { CacheUse } from "@harness/native";
import { z } from "zod";
const encodedKeys = process.env["HARNESS_SERVER_CACHE_KEYS"];
const keys =
  encodedKeys === undefined
    ? undefined
    : z.tuple([z.string(), z.string()]).parse(JSON.parse(encodedKeys));
const usage = keys === undefined ? undefined : new CacheUse(defaultHome(), keys);
try {
  if (process.send !== undefined) {
    if (usage === undefined) throw new Error("Managed startup has no cache-use guards");
    await new Promise<void>((resolve, reject) => {
      const disconnected = () => reject(new Error("Startup manager left before cache-use handoff"));
      process.once("disconnect", disconnected);
      process.once("message", (message) => {
        process.off("disconnect", disconnected);
        if (JSON.stringify(message) !== '{"type":"cache-use-accepted"}')
          reject(new Error("Invalid startup cache-use acceptance"));
        else resolve();
      });
      process.send!({ type: "cache-use-held" }, (error: Error | null) => {
        if (error) reject(error);
      });
    });
    process.disconnect!();
  }
  const commandIndex = process.argv.indexOf("--connection-command");
  const bridgeIndex = process.argv.indexOf("--host-bridge");
  if (bridgeIndex !== -1) {
    const value = hostConnectionTargetSchema.parse(JSON.parse(process.argv[bridgeIndex + 1]!));
    if (value.runtime === null) {
      const captured = process.env["HARNESS_PREPARED_SERVER"];
      if (captured === undefined) throw new Error("The desktop did not prepare its Local server");
      const runtime = await prepareLocalRuntime(
        preparedServerSchema.parse(JSON.parse(captured)),
        defaultHome(),
      );
      await runLocalBridge(runtime.home, runtime.launch, (identity) => {
        process.stderr.write(JSON.stringify({ type: "localOwner", identity }) + "\n");
      });
    } else {
      await runRemoteBridge(value.host, value.runtime);
    }
  } else if (commandIndex !== -1) {
    const cancel = new AbortController();
    process.stdin.once("end", () => cancel.abort());
    process.stdin.resume();
    try {
      const value = connectionCommandSchema.parse(JSON.parse(process.argv[commandIndex + 1]!));
      const result = await runConnectionCommand(value, dirname(process.argv[1]!), {
        signal: cancel.signal,
        progress: (message) =>
          process.stderr.write(JSON.stringify({ type: "progress", message }) + "\n"),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      // A paused pipe can retain a pending Windows read and keep this helper alive.
      process.stdin.destroy();
    }
  } else if (process.argv.includes("--attach-only")) await runLocalBridge(defaultHome());
  else if (process.argv.includes("--background")) await runBackgroundServer();
  else if (process.argv.includes("--bridge"))
    await runLocalBridge(defaultHome(), {
      executable: process.execPath,
      args: [...process.execArgv, process.argv[1]!, "--background"],
      ...(process.env["HARNESS_SERVER_SELECTION"] === undefined
        ? {}
        : {
            selection: serverCacheEntrySchema.parse(process.env["HARNESS_SERVER_SELECTION"]),
          }),
      env: { HARNESS_SERVER_CACHE_KEYS: encodedKeys },
      ...(keys === undefined ? {} : { retainUse: () => new CacheUse(defaultHome(), keys) }),
    });
  else await runStdioServer();
} catch (error) {
  console.error(error);
  process.exitCode =
    error instanceof Error && (error.cause as { code?: string } | undefined)?.code === "SQLITE_BUSY"
      ? 76
      : 1;
} finally {
  usage?.close();
}
