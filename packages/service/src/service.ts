import type {
  Conversation,
  ConversationConfig,
  ConversationId,
  DeliveryIntent,
  HarnessEvent,
  ItemId,
  Plugin,
  Store,
} from "@harness/protocol";
import { Engine, PluginHost } from "@harness/core";

export interface HarnessServiceOptions {
  store: Store;
  plugins: Plugin[];
}

export type EventListener = (event: HarnessEvent) => void;

/**
 * The single façade every client calls: typed events out, one delivery seam in.
 * Holds no control state — that lives in the loop and the log.
 */
export class HarnessService {
  readonly #store: Store;
  readonly #engine: Engine;

  constructor(options: HarnessServiceOptions) {
    this.#store = options.store;
    this.#engine = new Engine(options.store, new PluginHost(options.plugins));
  }

  createConversation(config: ConversationConfig): Promise<Conversation> {
    return this.#store.createConversation({ config });
  }

  /**
   * Delivers user text with the given intent (`send`/`steer`/`queue`/`interrupt`).
   * Resolves once it is accepted, not once its turn completes. An empty-text
   * `interrupt` is a pure abort (no message seeds the next turn).
   */
  deliver(conversationId: ConversationId, text: string, intent: DeliveryIntent): Promise<void> {
    return this.#engine.deliver(
      conversationId,
      { source: { kind: "user" }, content: text ? [{ type: "text", text }] : [] },
      intent,
    );
  }

  /** Sugar for `deliver(id, text, "send")`. */
  send(conversationId: ConversationId, text: string): Promise<void> {
    return this.deliver(conversationId, text, "send");
  }

  /**
   * Answers a pending middleware request (e.g. an approval prompt) raised via
   * `ctx.request` and surfaced as a `request.created` event. A no-op if the request
   * is no longer pending.
   */
  respond(conversationId: ConversationId, requestId: string, response: unknown): void {
    this.#engine.respond(conversationId, requestId, response);
  }

  /**
   * Moves the conversation's head to an earlier item (linear rewind). The next
   * `deliver` continues from there. Throws if a turn is running.
   */
  rewind(conversationId: ConversationId, toItemId: ItemId): Promise<void> {
    return this.#engine.rewind(conversationId, toItemId);
  }

  /** Resolves when the conversation has no running or queued work. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#engine.whenIdle(conversationId);
  }

  /** Subscribes to the typed event stream. Returns an unsubscribe handle. */
  subscribe(listener: EventListener): () => void {
    return this.#engine.subscribe({ onEvent: listener });
  }
}
