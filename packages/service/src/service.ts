import type {
  Conversation,
  ConversationConfig,
  ConversationId,
  HarnessEvent,
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

  /** Delivers a user message with `send` intent. Resolves once it is accepted. */
  send(conversationId: ConversationId, text: string): Promise<void> {
    return this.#engine.deliver(
      conversationId,
      { source: { kind: "user" }, content: [{ type: "text", text }] },
      "send",
    );
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
