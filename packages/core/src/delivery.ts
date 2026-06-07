import { assertNever } from "@harness/protocol";
import type { Delivery, Session } from "./session.ts";

/**
 * The cohesive intent → behavior module. All decisions about *how* a delivery
 * joins the loop live here, expressed as mutations of session state; the engine's
 * loop stays free of branches on intent. The engine ensures the drain loop runs
 * after this returns.
 *
 * Only `send` is wired. `steer`/`queue`/`interrupt` have their seams in place
 * (the mailbox, the per-turn `controller`, the turn-end drain) but are not yet
 * mapped — they throw rather than silently behaving like `send`.
 */
export function applyDelivery(session: Session, delivery: Delivery): void {
  switch (delivery.intent) {
    case "send":
      // Append to the FIFO mailbox. If the loop is idle it starts and consumes
      // this immediately; if a turn is running it runs once that turn ends.
      session.mailbox.push(delivery);
      return;
    case "steer":
    case "queue":
    case "interrupt":
      throw new Error(`delivery intent '${delivery.intent}' not yet supported`);
    default:
      return assertNever(delivery.intent);
  }
}
