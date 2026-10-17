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

export type ConversationPageCursor =
  { createdAt: number; id: ConversationId } | { lastUsedAt: number; id: ConversationId };

export interface ConversationListOptions {
  order?: "created" | "lastUsed";
  workspaceRoot?: string | null;
  /** Original project when recorded, otherwise the execution workspace. */
  projectRoot?: string;
  excludedState?: { plugin: string; key: string };
  includedState?: { plugin: string; key: string; scope: string };
}
export interface ConversationProject {
  /** Project identity rather than a worktree's execution directory. */
  workspaceRoot: string;
  lastUsedAt: number;
}
export type ConversationProjectCursor = ConversationProject;

/**
 * Persistence boundary. The item log is the only durable state. The store deals in
 * `ConversationRecord` (durable identity + overrides) — it never sees the resolved `config`, which
 * the service derives from the settings cascade on load.
 */
export type ManagedWorktree = {
  path: string;
  repository: string;
  createdAt: number;
};

export interface Store {
  putManagedWorktree(worktree: ManagedWorktree): Promise<void>;
  getManagedWorktree(path: string): Promise<ManagedWorktree | undefined>;
  listManagedWorktrees(limit: number, before?: string): Promise<ManagedWorktree[]>;
  deleteManagedWorktree(path: string): Promise<void>;
  createConversation(input: NewConversationRecord): Promise<ConversationRecord>;
  /** Atomically fork the prefix before a user item; shared items remain immutable. */
  forkConversation(
    source: ConversationId,
    userMessageId: ItemId,
    overrides: ConversationOverrides,
  ): Promise<ConversationRecord>;
  /** Updates metadata only when the current title equals the captured value. */
  updateConversationTitle(
    id: ConversationId,
    title: string,
    expected: string | null,
  ): Promise<boolean>;
  /** Change execution directory while preserving the original settings root. */
  updateConversationWorkspace(
    id: ConversationId,
    workspaceRoot: string,
  ): Promise<ConversationRecord>;
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
    options?: ConversationListOptions,
  ): Promise<ConversationRecord[]>;
  /** Commit synchronously before inbox acceptance, so write failure cannot reject accepted input. */
  recordUserInput(id: ConversationId): number;
  /** Folder groups, derived from conversation metadata; excludes a composition-owned mark. */
  listConversationProjects(
    limit: number,
    before?: ConversationProjectCursor,
    excludedState?: { plugin: string; key: string },
  ): Promise<ConversationProject[]>;

  /**
   * Append-only. Assigns `seq`/`createdAt`, links `parent` to the current `head`,
   * and advances `head`. Callers never set `parent`.
   */
  appendItem(input: NewItem): Promise<Item>;
  /** The raw log in `seq` order (full history, including abandoned branches). */
  listOwnedItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]>;

  /** Move head to an existing item, irrespective of physical owner. */
  setHead(conversationId: ConversationId, itemId: ItemId): Promise<void>;
  /** Items on head's ancestor chain, oldest first by chain position, across owners. */
  listActiveItems(conversationId: ConversationId): Promise<Item[]>;
  /** One immutable item by its globally unique ID. */
  getItem(itemId: ItemId): Promise<Item | undefined>;
  /** Newest-first parent walk beginning at `start`, bounded by item count. */
  listItemAncestors(start: ItemId | null, limit: number): Promise<Item[]>;

  createTurn(conversationId: ConversationId): Promise<Turn>;
  updateTurn(id: TurnId, status: TurnStatus): Promise<Turn>;
  /**
   * The single persisted-`running` turn for a conversation, if any. Liveness is
   * owned in-memory by the engine; this is consulted only by crash reconciliation.
   */
  getActiveTurn(conversationId: ConversationId): Promise<Turn | undefined>;
  getLatestTurn(conversationId: ConversationId): Promise<Turn | undefined>;

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
    scope?: string,
  ): Promise<void>;
  getPluginState(plugin: string, conversationId: ConversationId, key: string): Promise<unknown>;

  putBlob(bytes: Uint8Array): Promise<OutputRef>;
  getBlob(ref: OutputRef, range?: ByteRange): Promise<Uint8Array>;
}
