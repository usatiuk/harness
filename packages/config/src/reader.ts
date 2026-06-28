import type {
  ConfigReader,
  ConfigResolver,
  ConversationConfig,
  ConversationId,
  Store,
} from "@harness/protocol";

/**
 * Serves a plugin's resolved config slice for a conversation. Hot path reads the live runtime's
 * resolved config via `configFor`; falls back to resolving the stored record when no runtime is
 * live. Always reflects the current cascade + overrides — never a stale creation-time snapshot.
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
