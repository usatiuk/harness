import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import type { Conversation, NewConversation, Turn, TurnStatus } from "./conversation.ts";
import type { Item, NewItem } from "./items.ts";
import type { ProviderPayload } from "./model.ts";
import type { ContextBuild, NewContextBuild } from "./policies.ts";
import type { OutputRef } from "./tools.ts";

export interface SeqRange {
  fromSeq?: number; // inclusive
  toSeq?: number; // inclusive
}

export interface ByteRange {
  offset: number;
  length: number;
}

/** Persistence boundary. The item log is the only durable state. */
export interface Store {
  createConversation(input: NewConversation): Promise<Conversation>;
  getConversation(id: ConversationId): Promise<Conversation | undefined>;

  /** Append-only. Assigns a monotonic per-conversation `seq` and `createdAt`. */
  appendItem(input: NewItem): Promise<Item>;
  listItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]>;

  createTurn(conversationId: ConversationId): Promise<Turn>;
  updateTurn(id: TurnId, status: TurnStatus): Promise<Turn>;
  /**
   * The single persisted-`running` turn for a conversation, if any. Liveness is
   * owned in-memory by the engine; this is consulted only by crash reconciliation.
   */
  getActiveTurn(conversationId: ConversationId): Promise<Turn | undefined>;

  recordContextBuild(input: NewContextBuild): Promise<ContextBuild>;

  putProviderPayload(payload: ProviderPayload): Promise<void>;
  getProviderPayloads(itemIds: ItemId[]): Promise<ProviderPayload[]>;

  putPluginState(
    plugin: string,
    conversationId: ConversationId,
    key: string,
    value: unknown,
  ): Promise<void>;
  getPluginState(plugin: string, conversationId: ConversationId, key: string): Promise<unknown>;

  putBlob(bytes: Uint8Array): Promise<OutputRef>;
  getBlob(ref: OutputRef, range?: ByteRange): Promise<Uint8Array>;
}
