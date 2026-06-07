import type {
  Conversation,
  ConversationConfig,
  ConversationId,
  Event,
  Plugin,
  Store,
} from "@harness/protocol";
import { Engine, PluginHost } from "@harness/core";

export interface HarnessServiceOptions {
  store: Store;
  plugins: Plugin[];
}

export type EventListener = (event: Event) => void;

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

  /** Delivers a user message with `send` intent. */
  send(conversationId: ConversationId, text: string): Promise<void> {
    return this.#engine.deliver(conversationId, { text }, "send");
  }

  /** Subscribes to the typed event stream. Returns an unsubscribe handle. */
  subscribe(listener: EventListener): () => void {
    return this.#engine.subscribe({ onEvent: listener });
  }
}
