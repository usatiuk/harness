import type {
  Clock,
  Conversation,
  ContextBuild,
  ConversationId,
  IdGenerator,
  Item,
  ItemId,
  NewContextBuild,
  NewConversation,
  NewItem,
  NewTurn,
  OutputRef,
  ProviderPayload,
  Store,
  ByteRange,
  SeqRange,
  Turn,
  TurnId,
  TurnPatch,
} from "@harness/protocol";
import { systemClock, uuidIdGenerator } from "./defaults.ts";

const pluginStateKey = (plugin: string, conversationId: ConversationId, key: string): string =>
  `${plugin} ${conversationId} ${key}`;

/** Reference, non-durable Store. The contract suite (testkit) holds the spec. */
export class InMemoryStore implements Store {
  readonly #conversations = new Map<ConversationId, Conversation>();
  readonly #items = new Map<ConversationId, Item[]>();
  readonly #turns = new Map<TurnId, Turn>();
  readonly #payloads = new Map<ItemId, ProviderPayload>();
  readonly #pluginState = new Map<string, unknown>();
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #contextBuilds: ContextBuild[] = [];
  #counter = 0;

  constructor(
    private readonly ids: IdGenerator = uuidIdGenerator,
    private readonly clock: Clock = systemClock,
  ) {}

  async createConversation(input: NewConversation): Promise<Conversation> {
    const conversation: Conversation = {
      id: this.ids.conversationId(),
      config: input.config,
      createdAt: this.clock.now(),
    };
    this.#conversations.set(conversation.id, conversation);
    this.#items.set(conversation.id, []);
    return conversation;
  }

  async getConversation(id: ConversationId): Promise<Conversation | undefined> {
    return this.#conversations.get(id);
  }

  async appendItem(input: NewItem): Promise<Item> {
    const log = this.#items.get(input.conversationId);
    if (!log) {
      throw new Error(`unknown conversation: ${input.conversationId}`);
    }
    const item: Item = {
      ...input,
      id: this.ids.itemId(),
      seq: log.length,
      createdAt: this.clock.now(),
    };
    log.push(item);
    return item;
  }

  async listItems(conversationId: ConversationId, range?: SeqRange): Promise<Item[]> {
    const log = this.#items.get(conversationId) ?? [];
    const from = range?.fromSeq ?? 0;
    const to = range?.toSeq ?? Number.POSITIVE_INFINITY;
    return log.filter((i) => i.seq >= from && i.seq <= to);
  }

  async createTurn(input: NewTurn): Promise<Turn> {
    if (this.#activeTurn(input.conversationId)) {
      throw new Error(`conversation ${input.conversationId} already has a running turn`);
    }
    const turn: Turn = {
      id: this.ids.turnId(),
      conversationId: input.conversationId,
      status: "running",
      createdAt: this.clock.now(),
    };
    this.#turns.set(turn.id, turn);
    return turn;
  }

  async updateTurn(patch: TurnPatch): Promise<Turn> {
    const turn = this.#turns.get(patch.id);
    if (!turn) {
      throw new Error(`unknown turn: ${patch.id}`);
    }
    const updated: Turn = { ...turn, status: patch.status };
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
}
