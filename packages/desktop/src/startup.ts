import type { StartupProgress } from "@harness/connections";
import { timeoutSecondsSchema } from "@harness/protocol";

export const sessionLimitKey = "desktop.sessionTimeoutSeconds";
export function sessionTimeoutSeconds() {
  const stored = globalThis.window?.localStorage.getItem(sessionLimitKey);
  return timeoutSecondsSchema.parse(stored ? Number(stored) : 120);
}

export interface StartupStep {
  message: string;
  start: number;
  end?: number;
  progress?: StartupProgress;
}
/** One connection attempt. Durations use the desktop's monotonic clock across all hosts. */
export class StartupAttempt {
  readonly steps: StartupStep[] = [];
  step(message: string, progress?: StartupProgress) {
    const current = this.steps.at(-1);
    if (current?.message === message && progress && current.end === undefined) {
      current.progress = progress;
      return;
    }
    const now = performance.now();
    this.finish(now);
    this.steps.push({ message, start: now, ...(progress ? { progress } : {}) });
  }
  finish(now = performance.now()) {
    const current = this.steps.at(-1);
    if (current && current.end === undefined) current.end = now;
  }
}
