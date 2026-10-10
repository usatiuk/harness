import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { expect, it, onTestFailed, vi } from "vitest";
import { LifecycleLock, type NativeLifecycleLock } from "@harness/native";
import { withServerLifecycle } from "./lifecycle.ts";

it("cancels an acquirer without releasing another process's lifecycle ownership", async () => {
  const started = performance.now();
  const phases: { phase: string; ms: number }[] = [];
  const phase = (phase: string) => phases.push({ phase, ms: performance.now() - started });
  onTestFailed(() => console.error(JSON.stringify({ event: "lifecycle.test", phases })));
  const home = join(tmpdir(), `harness-lifecycle-${randomUUID()}`);
  phase("spawn-lock-owner");
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      "--input-type=module",
      "--import=tsx",
      "-e",
      `
    import { once } from 'node:events';
    import { withServerLifecycle } from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
    await withServerLifecycle(process.env.HARNESS_HOME, async () => {
      process.stdout.write('held\\n');
      process.stdin.resume();
      await once(process.stdin, 'end');
    });
  `,
    ],
    {
      env: { ...process.env, HARNESS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  try {
    expect(
      await Promise.race([
        once(lines, "line"),
        closed.then(() => {
          throw new Error(diagnostic || "Lock owner exited before admission");
        }),
      ]),
    ).toEqual(["held"]);
    phase("child-holds-lock");
    const probe = new LifecycleLock(home);
    phase("probe-created");
    try {
      expect(probe.tryAcquire()).toBe(false);
      const abort = new AbortController();
      let entered = false;
      let recordContention!: () => void;
      const contended = new Promise<void>((resolve) => {
        recordContention = resolve;
      });
      const prototype = Object.getPrototypeOf(probe) as NativeLifecycleLock;
      // Each call below supplies that lock's own receiver, including the waiter.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const acquire = prototype.tryAcquire;
      // Observe the real OS result, so cancellation exercises an actual waiter.
      const observed = vi.spyOn(prototype, "tryAcquire").mockImplementation(function (
        this: NativeLifecycleLock,
      ) {
        const acquired = acquire.call(this);
        if (!acquired) recordContention();
        return acquired;
      });
      const cancelled = withServerLifecycle(
        home,
        async () => {
          entered = true;
        },
        abort.signal,
      );
      try {
        await Promise.race([
          contended,
          cancelled.then(() => {
            throw new Error("Acquired lifecycle ownership while the other process still held it");
          }),
        ]);
        phase("acquirer-contended");
        abort.abort();
        await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        abort.abort();
        await cancelled.catch(() => undefined);
        observed.mockRestore();
      }
      phase("acquirer-cancelled");
      expect(entered).toBe(false);
      expect(probe.tryAcquire()).toBe(false);
    } finally {
      probe.close();
    }
    child.stdin.end();
    expect(await closed).toEqual([0, null]);
    phase("owner-exited");
    expect(await withServerLifecycle(home, async () => "admitted")).toBe("admitted");
    phase("fresh-operation-admitted");
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("releases lifecycle ownership after a failed operation", async () => {
  const home = join(tmpdir(), `harness-lifecycle-scope-${randomUUID()}`);
  const failure = new Error("Operation failed");
  try {
    await expect(
      withServerLifecycle(home, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await withServerLifecycle(home, async () => "admitted")).toBe("admitted");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
