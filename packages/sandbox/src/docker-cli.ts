import { spawn } from "node:child_process";

export interface CaptureResult {
  /** Raw stdout bytes — binary-safe, so file reads round-trip exactly. */
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/**
 * Runs `bin args`, capturing stdout as bytes and stderr as text. Optional `input` is written to
 * stdin (for piping a file's bytes into the container); `signal` aborts the child. Rejects only on
 * spawn failure or abort — a non-zero exit is returned, not thrown, so each caller decides what an
 * exit code means (a missing file is an error for `read`, but "not a directory" is normal for `stat`).
 */
export function capture(
  bin: string,
  args: string[],
  opts: { input?: Uint8Array; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<CaptureResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const out: Buffer[] = [];
    let err = "";
    let failure: Error | undefined;
    let bytes = 0;
    const withinLimit = (b: Buffer): boolean => {
      bytes += b.length;
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
        failure ??= new Error("Captured process output exceeds its byte limit");
        child.kill("SIGKILL");
        return false;
      }
      return true;
    };
    child.stdout?.on("data", (b: Buffer) => {
      if (withinLimit(b)) out.push(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (withinLimit(b)) err += b.toString("utf8");
    });
    // AbortError is emitted before the child has exited. Resource owners must await close.
    child.on("error", (error: Error) => {
      failure = error;
    });
    child.on("close", (code) => {
      if (failure) reject(failure);
      else resolvePromise({ stdout: Buffer.concat(out), stderr: err, exitCode: code ?? 1 });
    });
    child.stdin?.end(opts.input ?? undefined);
  });
}

/** `capture` with stdout decoded as UTF-8 — for commands whose output is text, not file bytes. */
export async function captureText(
  bin: string,
  args: string[],
  opts: { input?: Uint8Array; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await capture(bin, args, opts);
  return { stdout: r.stdout.toString("utf8"), stderr: r.stderr, exitCode: r.exitCode };
}
