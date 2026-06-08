import type { ConfigReader, ConversationId, Store } from "@harness/protocol";

/** Reads plugin config slices from the store row each call — no cache, so a live config change is never stale. */
export class StoreConfigReader implements ConfigReader {
  constructor(private readonly store: Store) {}

  async get<C = unknown>(pluginId: string, conversationId: ConversationId): Promise<C> {
    const conversation = await this.store.getConversation(conversationId);
    if (!conversation) throw new Error(`unknown conversation: ${conversationId}`);
    return (conversation.config.plugins?.[pluginId] ?? {}) as C;
  }
}
