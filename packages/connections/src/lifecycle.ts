import { setTimeout as delay } from "node:timers/promises";
import { LifecycleLock } from "@harness/native";
import { canonicalHome } from "./local.ts";

/** The outer manager holds the gate through stop/readiness; RPC owners never take it. */
export async function withServerLifecycle<T>(
  requestedHome: string,
  operation: (home: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const home = await canonicalHome(requestedHome);
  signal?.throwIfAborted();
  const deadline = Date.now() + 20_000;
  const guard = new LifecycleLock(home);
  try {
    while (!guard.tryAcquire()) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw new Error(
          "Another Harness server operation is still running; try again when it finishes",
        );
      await delay(50, undefined, { signal });
    }
    signal?.throwIfAborted();
    return await operation(home);
  } finally {
    guard.close();
  }
}
