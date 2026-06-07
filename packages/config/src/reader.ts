import type { ConfigReader, ConversationConfig, ConversationId, Store } from "@harness/protocol";

/**
 * Reads plugin config slices from the conversation's frozen snapshot (validated +
 * defaulted at creation). Config is immutable, so the conversation is cached per id.
 */
export class StoreConfigReader implements ConfigReader {
  readonly #cache = new Map<ConversationId, ConversationConfig>();

  constructor(private readonly store: Store) {}

  async get<C = unknown>(pluginId: string, conversationId: ConversationId): Promise<C> {
    let config = this.#cache.get(conversationId);
    if (!config) {
      const conversation = await this.store.getConversation(conversationId);
      if (!conversation) throw new Error(`unknown conversation: ${conversationId}`);
      config = conversation.config;
      this.#cache.set(conversationId, config);
    }
    return (config.plugins?.[pluginId] ?? {}) as C;
  }
}
