import { runStdioServer } from "./index.ts";
import { runBackgroundServer } from "./background.ts";
import { runLocalBridge } from "@harness/connections/node";
import { defaultHome } from "@harness/config";
try {
  if (process.argv.includes("--background")) await runBackgroundServer();
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
