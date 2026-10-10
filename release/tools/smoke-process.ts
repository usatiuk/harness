import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

/** Smoke processes have their own Unix group. On Windows, use the OS tree
 * termination command against only the child spawned by this fixture. */
export async function terminateSmokeProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Smoke parent already retired; descendant retirement is unconfirmed");
    await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5000,
    });
  } else process.kill(-child.pid, "SIGKILL");
}

export async function awaitSmokeExit<T>(exited: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      exited,
      delay(5000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Smoke process tree did not physically retire");
      }),
    ]);
  } finally {
    controller.abort();
  }
}

export function smokeProcessDeadline<T>(
  child: ChildProcess,
  exited: Promise<T>,
  milliseconds: number,
) {
  let termination: Promise<void> | undefined;
  let stopTimer: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      termination = terminateSmokeProcess(child);
      void termination.then(() => reject(new Error("Smoke process exceeded its deadline")), reject);
    }, milliseconds);
    stopTimer = () => clearTimeout(timer);
  });
  return {
    expired,
    async finish(): Promise<T> {
      stopTimer();
      if (termination) await termination;
      try {
        return await awaitSmokeExit(exited);
      } catch (error) {
        if (!termination) await terminateSmokeProcess(child);
        await awaitSmokeExit(exited);
        throw error;
      }
    },
  };
}
