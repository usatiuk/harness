import type { Conversation, DeliveryInput, DeliveryIntent } from "@harness/protocol";

/** One queued unit of input plus how it wants to join the loop. */
export interface Delivery {
  input: DeliveryInput;
  intent: DeliveryIntent;
}

/**
 * Per-conversation in-memory runtime. It — not the store — is the authority on
 * turn liveness while the process is alive: a single detached drain loop pulls
 * from the mailbox and runs turns one at a time. New input never starts a second
 * concurrent turn; it lands in the mailbox and runs at the next boundary.
 */
export class Session {
  readonly conversation: Conversation;
  /** FIFO of accepted-but-not-yet-run input. The drain loop owns consumption. */
  readonly mailbox: Delivery[] = [];
  /** Whether the detached drain loop is currently active. */
  running = false;
  /** The in-flight turn's abort handle; present only while a turn runs. */
  controller: AbortController | undefined;
  #idleWaiters: Array<() => void> = [];

  constructor(conversation: Conversation) {
    this.conversation = conversation;
  }

  /** Resolves once the loop is not running and the mailbox is drained. */
  whenIdle(): Promise<void> {
    if (!this.running && this.mailbox.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Wakes everyone waiting on quiescence. Called by the loop when it stops. */
  signalIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
