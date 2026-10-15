import type {
  ManagedWorktree,
  Clock,
  ConversationPageCursor,
  ConversationListOptions,
  ConversationProject,
  ConversationProjectCursor,
  ContextBuild,
  ConversationId,
  ConversationOverrides,
  ConversationRecord,
  IdGenerator,
  Item,
  ItemId,
  ModelUsage,
  ModelUsageSummary,
  NewContextBuild,
  NewConversationRecord,
  NewItem,
  NewModelUsage,
  OutputRef,
  ProviderPayload,
  Store,
  ByteRange,
  SeqRange,
  Turn,
  TurnId,
  TurnStatus,
} from "@harness/protocol";
import { addUsage, zeroUsage, summarizeTurnUsage } from "@harness/protocol";
import { systemClock, uuidIdGenerator } from "./defaults.ts";

const pluginStateKey = (plugin: string, conversationId: ConversationId, key: string): string =>
  `${plugin} ${conversationId} ${key}`;

/** Reference, non-durable Store. The contract suite (testkit) holds the spec. */
export class InMemoryStore implements Store {
  readonly #worktrees = new Map<string, ManagedWorktree>();
  readonly #conversations = new Map<ConversationId, ConversationRecord>();
  readonly #items = new Map<ConversationId, Item[]>();
  readonly #byId = new Map<ItemId, Item>();
  readonly #turns = new Map<TurnId, Turn>();
  readonly #payloads = new Map<ItemId, ProviderPayload>();
  readonly #pluginState = new Map<string, unknown>();
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #contextBuilds: ContextBuild[] = [];
  readonly #modelUsage: ModelUsage[] = [];
  #counter = 0;

  constructor(
    private readonly ids: IdGenerator = uuidIdGenerator,
    private readonly clock: Clock = systemClock,
  ) {}

  async putManagedWorktree(worktree: ManagedWorktree): Promise<void> {
    this.#worktrees.set(worktree.path, { ...worktree });
  }
  async getManagedWorktree(path: string): Promise<ManagedWorktree | undefined> {
    return this.#worktrees.get(path);
  }
  async listManagedWorktrees(limit: number, before?: string): Promise<ManagedWorktree[]> {
    return [...this.#worktrees.values()]
      .filter((tree) => !before || tree.path > before)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limit);
  }
  async deleteManagedWorktree(path: string): Promise<void> {
    this.#worktrees.delete(path);
  }

  async createConversation(input: NewConversationRecord): Promise<ConversationRecord> {
    const createdAt = this.clock.now();
    const record: ConversationRecord = {
      id: this.ids.conversationId(),
      workspaceRoot: input.workspaceRoot,
      ...(input.originalWorkspaceRoot
        ? { originalWorkspaceRoot: input.originalWorkspaceRoot }
        : {}),
      overrides: input.overrides,
      head: null,
      title: null,
      createdAt,
      lastUsedAt: createdAt,
    };
    this.#conversations.set(record.id, record);
    this.#items.set(record.id, []);
    return record;
  }

  async forkConversation(
    sourceId: ConversationId,
    userMessageId: ItemId,
    overrides: ConversationOverrides,
  ): Promise<ConversationRecord> {
    const source = this.#conversations.get(sourceId);
    if (!source) throw new Error(`unknown conversation: ${sourceId}`);
    const user = this.#byId.get(userMessageId);
    if (user?.type !== "message" || user.role !== "user")
      throw new Error("fork target must be a user message");
    const createdAt = this.clock.now();
    const record: ConversationRecord = {
      id: this.ids.conversationId(),
      workspaceRoot: source.workspaceRoot,
      ...(source.originalWorkspaceRoot
        ? { originalWorkspaceRoot: source.originalWorkspaceRoot }
        : {}),
      overrides,
      head: user.parent,
      title: source.title,
      createdAt,
      lastUsedAt: createdAt,
      fork: { conversationId: sourceId, userMessageId },
    };
    this.#conversations.set(record.id, record);
    this.#items.set(record.id, []);
    return record;
  }

  async updateConversationTitle(
    id: ConversationId,
    title: string,
    expected: string | null,
  ): Promise<boolean> {
    const record = this.#conversations.get(id);
    if (!record) throw new Error(`unknown conversation: ${id}`);
    if (record.title !== expected) return false;
    this.#conversations.set(id, { ...record, title });
    return true;
  }

  async updateConversationWorkspace(
    id: ConversationId,
    workspaceRoot: string,
  ): Promise<ConversationRecord> {
    const record = this.#conversations.get(id);
    if (!record) throw new Error(`unknown conversation: ${id}`);
    if (!record.workspaceRoot) throw new Error("Projectless conversations cannot switch worktrees");
    const updated = {
      ...record,
      workspaceRoot,
      originalWorkspaceRoot: record.originalWorkspaceRoot ?? record.workspaceRoot,
    };
    this.#conversations.set(id, updated);
    return updated;
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
    return this.#conversations.get(id);
  }

  async deleteConversationIfEmpty(id: ConversationId): Promise<void> {
    const conversation = this.#conversations.get(id);
    if (!conversation || conversation.head !== null) return;
    for (const turn of this.#turns.values()) {
      if (turn.conversationId === id) return;
    }
    this.#conversations.delete(id);
    this.#items.delete(id);
  }

  async updateConversationOverrides(
    id: ConversationId,
    patch: ConversationOverrides,
  ): Promise<void> {
    const record = this.#conversations.get(id);
    if (!record) {
      throw new Error(`unknown conversation: ${id}`);
    }
    this.#conversations.set(id, { ...record, overrides: { ...record.overrides, ...patch } });
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return this.#sortedConversations();
  }

  async listConversationPage(
    limit: number,
    before?: ConversationPageCursor,
    options: ConversationListOptions = {},
  ): Promise<ConversationRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const recent = options.order === "lastUsed";
    if (before && recent !== "lastUsedAt" in before) throw new Error("cursor order mismatch");
    const value = (record: ConversationRecord) => (recent ? record.lastUsedAt : record.createdAt);
    const cutoff = before
      ? "lastUsedAt" in before
        ? before.lastUsedAt
        : before.createdAt
      : undefined;
    return [...this.#conversations.values()]
      .filter(
        (record) =>
          (options.workspaceRoot === undefined || record.workspaceRoot === options.workspaceRoot) &&
          (!options.excludedState ||
            !this.#pluginState.has(
              pluginStateKey(options.excludedState.plugin, record.id, options.excludedState.key),
            )) &&
          (before === undefined ||
            value(record) < cutoff! ||
            (value(record) === cutoff && record.id < before.id)),
      )
      .sort((a, b) => value(b) - value(a) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  recordUserInput(id: ConversationId): number {
    const record = this.#conversations.get(id);
    if (!record) throw new Error(`unknown conversation: ${id}`);
    const lastUsedAt = this.clock.now();
    this.#conversations.set(id, { ...record, lastUsedAt });
    return lastUsedAt;
  }

  async listConversationProjects(
    limit: number,
    before?: ConversationProjectCursor,
    excludedState?: { plugin: string; key: string },
  ): Promise<ConversationProject[]> {
    const groups = new Map<string, number>();
    for (const record of this.#conversations.values()) {
      if (
        record.workspaceRoot === null ||
        (excludedState &&
          this.#pluginState.has(pluginStateKey(excludedState.plugin, record.id, excludedState.key)))
      )
        continue;
      groups.set(
        record.workspaceRoot,
        Math.max(groups.get(record.workspaceRoot) ?? -Infinity, record.lastUsedAt),
      );
    }
    return [...groups]
      .map(([workspaceRoot, lastUsedAt]) => ({ workspaceRoot, lastUsedAt }))
      .filter(
        (project) =>
          !before ||
          project.lastUsedAt < before.lastUsedAt ||
          (project.lastUsedAt === before.lastUsedAt &&
            Buffer.compare(Buffer.from(project.workspaceRoot), Buffer.from(before.workspaceRoot)) <
              0),
      )
      .sort(
        (a, b) =>
          b.lastUsedAt - a.lastUsedAt ||
          Buffer.compare(Buffer.from(b.workspaceRoot), Buffer.from(a.workspaceRoot)),
      )
      .slice(0, limit);
  }

  async appendItem(input: NewItem): Promise<Item> {
    const log = this.#items.get(input.conversationId);
    if (!log) {
      throw new Error(`unknown conversation: ${input.conversationId}`);
    }
    const conversation = this.#conversations.get(input.conversationId)!;
    const item: Item = {
      ...input,
      id: this.ids.itemId(),
      seq:
        Math.max(
          log.at(-1)?.seq ?? -1,
          conversation.head ? this.#byId.get(conversation.head)!.seq : -1,
        ) + 1,
      parent: conversation.head,
      createdAt: this.clock.now(),
    };
    log.push(item);
    this.#byId.set(item.id, item);
    this.#conversations.set(conversation.id, { ...conversation, head: item.id });
    return item;
  }

  async listOwnedItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]> {
    const log = this.#items.get(conversationId) ?? [];
    const from = range?.fromSeq ?? 0;
    const to = range?.toSeq ?? Number.POSITIVE_INFINITY;
    return log.filter((i) => i.seq >= from && i.seq <= to);
  }

  async setHead(conversationId: ConversationId, itemId: ItemId): Promise<void> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`unknown conversation: ${conversationId}`);
    }
    if (!this.#byId.has(itemId)) {
      throw new Error(`unknown item: ${itemId}`);
    }
    this.#conversations.set(conversationId, { ...conversation, head: itemId });
  }

  async listActiveItems(conversationId: ConversationId): Promise<Item[]> {
    const conversation = this.#conversations.get(conversationId);
    const chain: Item[] = [];
    for (let id = conversation?.head ?? null; id !== null;) {
      const item = this.#byId.get(id);
      if (!item) throw new Error(`missing history item: ${id}`);
      chain.push(item);
      id = item.parent;
    }
    return chain.reverse();
  }

  async getItem(itemId: ItemId): Promise<Item | undefined> {
    return this.#byId.get(itemId);
  }

  async listItemAncestors(start: ItemId | null, limit: number): Promise<Item[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const page: Item[] = [];
    for (let id = start; id !== null && page.length < limit;) {
      const item = this.#byId.get(id);
      if (!item) throw new Error(`unknown item: ${id}`);
      page.push(item);
      id = item.parent;
    }
    return page;
  }

  async createTurn(conversationId: ConversationId): Promise<Turn> {
    if (this.#activeTurn(conversationId)) {
      throw new Error(`conversation ${conversationId} already has a running turn`);
    }
    const turn: Turn = {
      id: this.ids.turnId(),
      conversationId,
      status: "running",
      createdAt: this.clock.now(),
    };
    this.#turns.set(turn.id, turn);
    return turn;
  }

  async updateTurn(id: TurnId, status: TurnStatus): Promise<Turn> {
    const turn = this.#turns.get(id);
    if (!turn) {
      throw new Error(`unknown turn: ${id}`);
    }
    const updated: Turn = { ...turn, status };
    this.#turns.set(updated.id, updated);
    return updated;
  }

  async getActiveTurn(conversationId: ConversationId): Promise<Turn | undefined> {
    return this.#activeTurn(conversationId);
  }

  async recordContextBuild(input: NewContextBuild): Promise<ContextBuild> {
    const build: ContextBuild = {
      ...input,
      id: `cb-${++this.#counter}`,
      createdAt: this.clock.now(),
    };
    this.#contextBuilds.push(build);
    return build;
  }

  async getContextBuild(id: string): Promise<ContextBuild | undefined> {
    return this.#contextBuilds.find((build) => build.id === id);
  }

  async recordModelUsage(input: NewModelUsage): Promise<ModelUsage> {
    const record: ModelUsage = {
      ...input,
      id: `mu-${++this.#counter}`,
      createdAt: this.clock.now(),
    };
    this.#modelUsage.push(record);
    return record;
  }

  async listModelUsage(conversationId: ConversationId): Promise<ModelUsage[]> {
    return this.#modelUsage.filter((u) => u.conversationId === conversationId);
  }

  async summarizeModelUsage(conversationId: ConversationId): Promise<ModelUsageSummary> {
    let usage = zeroUsage();
    let incomplete = false;
    let cost = 0;
    let costIncomplete = false;
    let lastInputTokens: number | undefined;
    let agent: ModelUsage | undefined;
    for (const row of this.#modelUsage) {
      if (row.conversationId !== conversationId) continue;
      if (row.purpose === "agent") agent = row;
      cost += row.cost ?? 0;
      costIncomplete ||= row.cost === null || row.costIncomplete === true;
      if (row.usage === null) {
        incomplete = true;
      } else {
        usage = addUsage(usage, row.usage);
        lastInputTokens = row.usage.inputTokens;
      }
      if (row.inputTokensAreContext === false) lastInputTokens = undefined;
    }
    const terminal = [...this.#turns.values()].findLast(
      (turn) => turn.conversationId === conversationId && turn.status !== "running",
    );
    return {
      usage,
      incomplete,
      cost,
      costIncomplete,
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
      ...(agent
        ? {
            agentContext: {
              provider: agent.provider,
              model: agent.model,
              turnId: agent.turnId,
              usage: agent.inputTokensAreContext === false ? null : agent.usage,
              createdAt: agent.createdAt,
            },
          }
        : {}),
      ...(terminal
        ? {
            lastTurn: summarizeTurnUsage(
              terminal,
              this.#modelUsage.filter((row) => row.turnId === terminal.id),
            ),
          }
        : {}),
    };
  }

  async putProviderPayload(payload: ProviderPayload): Promise<void> {
    this.#payloads.set(payload.itemId, payload);
  }

  async getProviderPayloads(itemIds: ItemId[]): Promise<ProviderPayload[]> {
    const out: ProviderPayload[] = [];
    for (const id of itemIds) {
      const payload = this.#payloads.get(id);
      if (payload) out.push(payload);
    }
    return out;
  }

  async putPluginState(
    plugin: string,
    conversationId: ConversationId,
    key: string,
    value: unknown,
  ): Promise<void> {
    this.#pluginState.set(pluginStateKey(plugin, conversationId, key), value);
  }

  async getPluginState(
    plugin: string,
    conversationId: ConversationId,
    key: string,
  ): Promise<unknown> {
    return this.#pluginState.get(pluginStateKey(plugin, conversationId, key));
  }

  async putBlob(bytes: Uint8Array): Promise<OutputRef> {
    const id = `blob-${++this.#counter}`;
    this.#blobs.set(id, bytes.slice());
    return {
      id,
      bytes: bytes.byteLength,
      contentType: "application/octet-stream",
    };
  }

  async getBlob(ref: OutputRef, range?: ByteRange): Promise<Uint8Array> {
    const bytes = this.#blobs.get(ref.id);
    if (!bytes) {
      throw new Error(`unknown blob: ${ref.id}`);
    }
    if (!range) return bytes.slice();
    return bytes.slice(range.offset, range.offset + range.length);
  }

  #activeTurn(conversationId: ConversationId): Turn | undefined {
    for (const turn of this.#turns.values()) {
      if (turn.conversationId === conversationId && turn.status === "running") {
        return turn;
      }
    }
    return undefined;
  }

  #sortedConversations(): ConversationRecord[] {
    return [...this.#conversations.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
  }
}
