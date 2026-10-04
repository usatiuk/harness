import { runStdioServer } from "./index.ts";
import { runBackgroundServer } from "./background.ts";
import { hostSchema } from "@harness/connections";
import {
  preparedRuntimeSchema,
  runRemoteBridge,
  runConnectionCommand,
  runLocalBridge,
  prepareLocalRuntime,
} from "@harness/connections/node";
import { dirname } from "node:path";
import { defaultHome } from "@harness/config";
import { z } from "zod";
try {
  const commandIndex = process.argv.indexOf("--connection-command");
  const bridgeIndex = process.argv.indexOf("--host-bridge");
  if (bridgeIndex !== -1) {
    const value = z
      .strictObject({ host: hostSchema, runtime: preparedRuntimeSchema.nullable() })
      .parse(JSON.parse(process.argv[bridgeIndex + 1]!));
    const host = value.host;
    if (host.kind === "local") {
      const runtime = await prepareLocalRuntime(dirname(process.argv[1]!), defaultHome());
      await runLocalBridge(runtime.home, runtime.launch, (identity) => {
        process.stderr.write(JSON.stringify({ type: "localOwner", identity }) + "\n");
      });
    } else {
      if (!value.runtime) throw new Error("Missing prepared remote runtime");
      await runRemoteBridge(host, value.runtime);
    }
  } else if (commandIndex !== -1) {
    const cancel = new AbortController();
    process.stdin.once("end", () => cancel.abort());
    process.stdin.resume();
    try {
      const value: unknown = JSON.parse(process.argv[commandIndex + 1]!);
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
    });
  else await runStdioServer();
} catch (error) {
  console.error(error);
  process.exitCode =
    error instanceof Error && (error.cause as { code?: string } | undefined)?.code === "SQLITE_BUSY"
      ? 76
      : 1;
}
