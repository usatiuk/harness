import type { ChildProcess } from "node:child_process";
import type { SpawnedProcess } from "./context.ts";

/** Grace after `exit` for stdio to drain before completion is forced (anti-stall fallback). */
export const FLUSH_GRACE_MS = 200;

/**
 * Wraps a `ChildProcess` as a `SpawnedProcess`: one streaming decoder per stream (a shared one
 * would join a mid-codepoint stdout chunk to the next stderr chunk and corrupt both), completion
 * that prefers stdio drain but falls back to a watchdog after `exit` (a forked grandchild holding
 * the pipe open can stop `close` from ever firing), and a caller-supplied `kill` — process-group
 * for the local substrate, in-container reaping for docker.
 */
export function streamProcess(child: ChildProcess, kill: () => void): SpawnedProcess {
  const listeners: ((chunk: string) => void)[] = [];
  const fanOf = (): ((buf: Buffer) => void) => {
    const decoder = new TextDecoder();
    return (buf) => {
      const text = decoder.decode(buf, { stream: true });
      for (const listener of listeners) listener(text);
    };
  };
  child.stdout?.on("data", fanOf());
  child.stderr?.on("data", fanOf());
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
    let settled = false;
    const settle = (r: { code: number | null; signal: string | null }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    child.on("close", (code, signal) => settle({ code, signal }));
    child.on("exit", (code, signal) =>
      setTimeout(() => settle({ code, signal }), FLUSH_GRACE_MS).unref(),
    );
    child.on("error", () => settle({ code: null, signal: null }));
  });
  return { pid: child.pid, exit, onData: (listener) => listeners.push(listener), kill };
}
