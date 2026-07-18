import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

interface KillHelper {
  once(event: "error", listener: () => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

type SpawnKillHelper = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: true },
) => KillHelper;

/** Windows process-tree termination, injectable so both fallback paths stay unit-testable. */
export function killWindowsProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  spawnKiller: SpawnKillHelper = (command, args, options) => nodeSpawn(command, args, options),
): void {
  if (child.pid === undefined) return;
  const fallback = (): void => {
    child.kill();
  };
  const killer = spawnKiller("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", fallback);
  killer.once("exit", (code) => {
    if (code !== 0) fallback();
  });
}
