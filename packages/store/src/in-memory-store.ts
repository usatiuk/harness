import type {
  Clock,
  ConversationPageCursor,
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
  readonly #conversations = new Map<ConversationId, ConversationRecord>();
  readonly #items = new Map<ConversationId, Item[]>();
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

  async createConversation(input: NewConversationRecord): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: this.ids.conversationId(),
      workspaceRoot: input.workspaceRoot,
      overrides: input.overrides,
      head: null,
      createdAt: this.clock.now(),
    };
    this.#conversations.set(record.id, record);
    this.#items.set(record.id, []);
    return record;
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
  ): Promise<ConversationRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    return this.#sortedConversations()
      .filter(
        (record) =>
          before === undefined ||
          record.createdAt < before.createdAt ||
          (record.createdAt === before.createdAt && record.id < before.id),
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
      seq: log.length,
      parent: conversation.head,
      createdAt: this.clock.now(),
    };
    log.push(item);
    this.#conversations.set(conversation.id, { ...conversation, head: item.id });
    return item;
  }

  async listItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]> {
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
    const log = this.#items.get(conversationId) ?? [];
    if (!log.some((i) => i.id === itemId)) {
      throw new Error(`item ${itemId} is not in conversation ${conversationId}`);
    }
    this.#conversations.set(conversationId, { ...conversation, head: itemId });
  }

  async listActiveItems(conversationId: ConversationId): Promise<Item[]> {
    const conversation = this.#conversations.get(conversationId);
    const log = this.#items.get(conversationId) ?? [];
    const byId = new Map(log.map((i) => [i.id, i]));
    const chain: Item[] = [];
    for (let id = conversation?.head ?? null; id !== null; ) {
      const item = byId.get(id);
      if (!item) break;
      chain.push(item);
      id = item.parent;
    }
    return chain.reverse();
  }

  async getItem(conversationId: ConversationId, itemId: ItemId): Promise<Item | undefined> {
    return this.#items.get(conversationId)?.find((item) => item.id === itemId);
  }

  async listItemAncestors(
    conversationId: ConversationId,
    start: ItemId | null,
    limit: number,
  ): Promise<Item[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
    const log = this.#items.get(conversationId) ?? [];
    const byId = new Map(log.map((item) => [item.id, item]));
    const page: Item[] = [];
    for (let id = start; id !== null && page.length < limit; ) {
      const item = byId.get(id);
      if (!item) break;
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
