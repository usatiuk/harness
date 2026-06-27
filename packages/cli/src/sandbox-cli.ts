import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { defaultHome, loadMergedSettings } from "@harness/config";
import { provisionDevcontainer, sandboxConfigSchema, stopSandbox } from "@harness/sandbox";

/** The sandbox `configPath` for `cwd`, read from the settings cascade (so a non-default path wins). */
async function configPathFor(cwd: string): Promise<string> {
  const doc = await loadMergedSettings(defaultHome(), cwd);
  return sandboxConfigSchema.parse(doc.plugins?.["sandbox"] ?? {}).configPath;
}

/**
 * Drops the user into an interactive shell inside the workspace's dev container. Runs outside the
 * Ink TUI (which can't hand over the real terminal), so it inherits stdio directly. Provisioning
 * reattaches to an already-running container by id-label, or builds one if none exists.
 */
export async function runSandboxShell(cwd?: string): Promise<void> {
  const root = resolve(cwd ?? process.cwd());
  console.error("starting dev container…");
  const h = await provisionDevcontainer(root, {
    configPath: await configPathFor(root),
    onStatus: (s) => {
      if (s.phase !== "ready") console.error(`  ${s.phase}${s.message ? `: ${s.message}` : ""}`);
    },
  });
  const res = spawnSync(
    "docker",
    ["exec", "-it", "-u", h.remoteUser, "-w", h.remoteWorkspaceFolder, h.containerId, "bash", "-l"],
    { stdio: "inherit" },
  );
  process.exitCode = res.status ?? 0;
}

/** Tears down the workspace's dev container(s). */
export async function runSandboxStop(cwd?: string): Promise<void> {
  const root = resolve(cwd ?? process.cwd());
  const removed = await stopSandbox(root);
  console.log(removed > 0 ? `stopped ${removed} container(s)` : "no sandbox container running");
}
