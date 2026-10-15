import type {
  Conversation,
  DeliveryInput,
  DeliveryIntent,
  TurnId,
  InteractionRequest,
} from "@harness/protocol";

/** One unit of accepted input plus how it wants to join the loop. */
export interface Delivery {
  input: DeliveryInput;
  intent: DeliveryIntent;
}

/**
 * Per-conversation in-memory state — the authority on turn liveness while the
 * process is alive (the store's persisted status is not). The Engine owns the loop logic; this is
 * just data. The production TUI limits loaded runtimes to one root and its descendants.
 */
export class Runtime {
  #conversation: Conversation;
  /**
   * One ordered, intent-tagged buffer of accepted-but-not-yet-injected input. The
   * drain loop takes it all at each turn boundary; mid-turn only `steer` entries
   * are pulled. The single buffer is why there is no live-vs-idle branching.
   */
  readonly inbox: Delivery[] = [];
  /** Whether the detached drain loop is currently active. */
  running = false;
  /** Deferred tool-requested selection, applied only after the entire batch settles. */
  pendingWorkspace: string | undefined;
  preparation: { controller: AbortController; done: Promise<void> } | undefined;
  workspaceSwitch:
    | {
        deferred: boolean;
        target: string | undefined;
        controller: AbortController;
        done: Promise<void>;
      }
    | undefined;
  /** The in-flight turn id; present only while a turn runs. Liveness signal. */
  currentTurnId: TurnId | undefined;
  /** The in-flight turn's abort handle; present only while a turn runs. */
  controller: AbortController | undefined;
  /** Activation-local plugin services hung off `ctx.service(key)`, built lazily per key. */
  readonly services = new Map<string, unknown>();
  /**
   * In-flight `ctx.request` calls awaiting a `respond`, keyed by requestId.
   * Ephemeral: a parked request that outlives the process is recovered by crash
   * reconciliation (its tool_call has no result), so nothing here is durable.
   */
  readonly pendingRequests = new Map<
    string,
    { request: InteractionRequest; resolve(response: unknown): void }
  >();
  #idleWaiters: Array<() => void> = [];

  constructor(conversation: Conversation) {
    this.#conversation = conversation;
  }

  /** The resolved conversation (durable record + its derived config). */
  get conversation(): Conversation {
    return this.#conversation;
  }

  /**
   * Swap in a re-resolved conversation (e.g. after a `/model` override). Replaced wholesale, never
   * mutated — a running turn holds its own turn-boundary snapshot, so this only affects the next
   * turn (a request's model must match its recorded usage).
   */
  setConversation(conversation: Conversation): void {
    this.#conversation = conversation;
  }

  /** Removes and returns the `steer`-tagged entries, preserving inbox order. */
  takeSteers(): Delivery[] {
    const steers: Delivery[] = [];
    const kept: Delivery[] = [];
    for (const entry of this.inbox) (entry.intent === "steer" ? steers : kept).push(entry);
    this.inbox.splice(0, this.inbox.length, ...kept);
    return steers;
  }

  /** Resolves once the loop is not running and the inbox is drained. */
  whenIdle(): Promise<void> {
    if (!this.running && this.inbox.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Wakes everyone waiting on quiescence. Called by the loop when it stops. */
  signalIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
