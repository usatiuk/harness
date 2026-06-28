import type {
  ConfigReader,
  ConfigResolver,
  ConversationConfig,
  ConversationId,
  Store,
} from "@harness/protocol";

/**
 * Serves a plugin's resolved config slice for a conversation. Reads the already-resolved config off
 * the live runtime via `configFor` (the hot path — a tool call only runs inside a loaded runtime),
 * and falls back to resolving the stored record when no runtime is live (e.g. a client read before
 * the first turn). Either way it reflects the current settings cascade + the conversation's
 * overrides — never a stale creation-time snapshot.
 */
export class ResolvedConfigReader implements ConfigReader {
  constructor(
    private readonly store: Store,
    private readonly resolveConfig: ConfigResolver,
    private readonly configFor: (id: ConversationId) => ConversationConfig | undefined,
  ) {}

  async get<C = unknown>(pluginId: string, conversationId: ConversationId): Promise<C> {
    const config = this.configFor(conversationId) ?? (await this.#resolve(conversationId));
    return (config.plugins?.[pluginId] ?? {}) as C;
  }

  async #resolve(conversationId: ConversationId): Promise<ConversationConfig> {
    const record = await this.store.getConversation(conversationId);
    if (!record) throw new Error(`unknown conversation: ${conversationId}`);
    return this.resolveConfig(record);
  }
}
