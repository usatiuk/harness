import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import type {
  ConversationOverrides,
  ConversationRecord,
  NewConversationRecord,
  Turn,
  TurnStatus,
} from "./conversation.ts";
import type { Item, NewItem } from "./items.ts";
import type { ProviderPayload } from "./model.ts";
import type { ContextBuild, NewContextBuild } from "./policies.ts";
import type { OutputRef } from "./tools.ts";
import type { ModelUsage, NewModelUsage } from "./usage.ts";
import type { ModelUsageSummary } from "./usage.ts";

export interface SeqRange {
  fromSeq?: number; // inclusive
  toSeq?: number; // inclusive
}

export interface ByteRange {
  offset: number;
  length: number;
}

export interface ConversationPageCursor {
  createdAt: number;
  id: ConversationId;
}

/**
 * Persistence boundary. The item log is the only durable state. The store deals in
 * `ConversationRecord` (durable identity + overrides) — it never sees the resolved `config`, which
 * the service derives from the settings cascade on load.
 */
export interface Store {
  createConversation(input: NewConversationRecord): Promise<ConversationRecord>;
  /** Updates metadata only when the current title equals the captured value. */
  updateConversationTitle(
    id: ConversationId,
    title: string,
    expected: string | null,
  ): Promise<boolean>;
  getConversation(id: ConversationId): Promise<ConversationRecord | undefined>;
  /**
   * Deletes the conversation iff still empty (head === null and no turn was ever
   * created); a no-op otherwise.
   */
  deleteConversationIfEmpty(id: ConversationId): Promise<void>;
  /**
   * Shallow-merge `patch` into the conversation's durable `overrides` layer (the only
   * post-creation mutation of conversation settings, e.g. a `/model` switch). Re-resolved on the
   * next load, so the change survives resume.
   */
  updateConversationOverrides(id: ConversationId, patch: ConversationOverrides): Promise<void>;
  /** All conversations, most-recent-first (by `createdAt`). The resume/listing source. */
  listConversations(): Promise<ConversationRecord[]>;
  /** Stable recent-first page; `before` is exclusive. */
  listConversationPage(
    limit: number,
    before?: ConversationPageCursor,
  ): Promise<ConversationRecord[]>;

  /**
   * Append-only. Assigns `seq`/`createdAt`, links `parent` to the current `head`,
   * and advances `head`. Callers never set `parent`.
   */
  appendItem(input: NewItem): Promise<Item>;
  /** The raw log in `seq` order (full history, including abandoned branches). */
  listItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]>;

  /** Move `head` (linear rewind). Throws if `itemId` is not in the conversation. */
  setHead(conversationId: ConversationId, itemId: ItemId): Promise<void>;
  /** Items on `head`'s ancestor chain, in `seq` order. The context-build source. */
  listActiveItems(conversationId: ConversationId): Promise<Item[]>;
  /** One immutable item, scoped to its owning conversation. */
  getItem(conversationId: ConversationId, itemId: ItemId): Promise<Item | undefined>;
  /** Newest-first parent walk beginning at `start`, bounded by item count. */
  listItemAncestors(
    conversationId: ConversationId,
    start: ItemId | null,
    limit: number,
  ): Promise<Item[]>;

  createTurn(conversationId: ConversationId): Promise<Turn>;
  updateTurn(id: TurnId, status: TurnStatus): Promise<Turn>;
  /**
   * The single persisted-`running` turn for a conversation, if any. Liveness is
   * owned in-memory by the engine; this is consulted only by crash reconciliation.
   */
  getActiveTurn(conversationId: ConversationId): Promise<Turn | undefined>;

  recordContextBuild(input: NewContextBuild): Promise<ContextBuild>;
  getContextBuild(id: string): Promise<ContextBuild | undefined>;

  /** Append-only. Assigns `id`/`createdAt`. */
  recordModelUsage(input: NewModelUsage): Promise<ModelUsage>;
  /** All usage rows for a conversation, in record order. */
  listModelUsage(conversationId: ConversationId): Promise<ModelUsage[]>;
  /** Constant-size aggregate computed without returning every usage row. */
  summarizeModelUsage(conversationId: ConversationId): Promise<ModelUsageSummary>;

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
