import { assertNever } from "@harness/protocol";
import type { Delivery, Runtime } from "./runtime.ts";

/**
 * Maps delivery intent → inbox mutation, the one place intent is interpreted (the
 * loop never branches on it). `send`/`queue`/`steer` only differ in call-site
 * intent and whether they flush mid-turn (steer only), so they share a branch.
 */
export function applyDelivery(runtime: Runtime, delivery: Delivery): void {
  switch (delivery.intent) {
    case "send":
    case "queue":
    case "steer":
      runtime.inbox.push(delivery);
      return;
    case "interrupt":
      // Abort the in-flight turn (no-op if idle), then enqueue any content so the
      // next turn drains it with everything else buffered.
      runtime.controller?.abort();
      if (delivery.input.content.length > 0) {
        runtime.inbox.push({ input: delivery.input, intent: "queue" });
      }
      return;
    default:
      return assertNever(delivery.intent);
  }
}
