import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { defaultHome } from "@harness/config";
import { HarnessClient } from "@harness/client";
import { ensureLocalServer } from "@harness/connections/node";
import { sandboxWorkspaceRequest } from "@harness/sandbox/client";
import { PRODUCT_VERSION } from "@harness/release";
import { prepareServerLaunch } from "./server-launch.ts";

async function workspace(path: string, action: "start" | "stop") {
  const prepared = await prepareServerLaunch("background");
  try {
    const local = await ensureLocalServer(defaultHome(), prepared.launch);
    const client = new HarnessClient({
      connection: local.connection,
      client: { name: "harness-sandbox", version: PRODUCT_VERSION },
    });
    try {
      await client.start();
      return await client.peer.request(sandboxWorkspaceRequest, { path, action });
    } finally {
      client.closeConnection();
      local.close();
    }
  } finally {
    await prepared.close();
  }
}

/** The terminal belongs to this process; its Docker environment belongs to the shared server. */
export async function runSandboxShell(cwd?: string): Promise<void> {
  const handle = await workspace(resolve(cwd ?? process.cwd()), "start");
  if (!handle) throw new Error("Server did not return the started Docker workspace");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-it",
      "-u",
      handle.remoteUser,
      "-w",
      handle.remoteWorkspaceFolder,
      handle.containerId,
      "bash",
      "-l",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

export async function runSandboxStop(cwd?: string): Promise<void> {
  await workspace(resolve(cwd ?? process.cwd()), "stop");
  console.log("Docker workspace stopped; container state retained");
}
