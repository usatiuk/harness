import type { ConversationOverrides, Conversation } from "./conversation.ts";
import type { ConversationId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { DeliveryInput, DeliveryIntent } from "./delivery.ts";
import type { Store } from "./store.ts";
import type { HarnessEvent } from "./events.ts";

/**
 * The conversation-control subset a plugin needs to spawn and observe child conversations — a
 * narrow window over `HarnessService`. Plugins can deliver input and establish tree ownership;
 * they never rewind or reconfigure a child.
 */
export interface ConversationRunner extends Pick<Store, "listConversationPage" | "getLatestTurn"> {
  prepare(id: ConversationId): Promise<void>;
  registerChild(parent: ConversationId, child: ConversationId): void;
  isConversationRunning(id: ConversationId): boolean;
  createConversation(opts: {
    cwd?: string;
    overrides?: ConversationOverrides;
    /** Internal tree ownership for a child spawned by this conversation. */
    parentId?: ConversationId;
  }): Promise<Conversation>;
  /** Deliver text with an intent — `send` to seed a turn, `interrupt` (empty text) to abort one. */
  deliver(id: ConversationId, text: string | DeliveryInput, intent: DeliveryIntent): Promise<void>;
  subscribe(id: ConversationId, listener: (event: HarnessEvent) => void): () => void;
  whenIdle(id: ConversationId): Promise<void>;
  /** The head's ancestry — the conversation's render/inspect source. */
  getItems(id: ConversationId): Promise<readonly Item[]>;
  /** A conversation with its config resolved on read (e.g. to read its durable `workspaceRoot`). */
  getConversation(id: ConversationId): Promise<Conversation | undefined>;
  /** Durable per-conversation plugin metadata — the store's `plugin_state`, forwarded verbatim. */
  putPluginState(
    plugin: string,
    id: ConversationId,
    key: string,
    value: unknown,
    scope?: string,
  ): Promise<void>;
  getPluginState(plugin: string, id: ConversationId, key: string): Promise<unknown>;
}
