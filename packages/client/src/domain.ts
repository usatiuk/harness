import type {
  Conversation,
  ConversationConfig,
  ConversationId,
  HarnessEvent,
  Item,
  ItemId,
  ModelInfo,
  ModelUsageSummary,
  TurnId,
  Usage,
  WireConversation,
  WireConversationConfig,
  WireConversationEvent,
  WireItem,
  WireModelInfo,
  WireUsageSummary,
} from "@harness/protocol";
import type { HarnessClientEvent } from "./client.ts";
import { HarnessClient } from "./client.ts";

const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
const encodedLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const decodeUsage = (usage: {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: Record<string, number> | null;
}): Usage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedReadTokens: usage.cachedReadTokens,
  ...(usage.cacheWriteTokens === null
    ? {}
    : {
        cacheWriteTokens: Object.fromEntries(
          Object.entries(usage.cacheWriteTokens).map(([ttl, count]) => [Number(ttl), count]),
        ),
      }),
});

export const decodeUsageSummary = (summary: WireUsageSummary): ModelUsageSummary => ({
  usage: decodeUsage(summary.usage),
  incomplete: summary.incomplete,
  cost: summary.cost,
  ...(summary.lastInputTokens === null ? {} : { lastInputTokens: summary.lastInputTokens }),
});

export const decodeConversationConfig = (config: WireConversationConfig): ConversationConfig => ({
  instructions: config.instructions,
  model: {
    provider: config.model.provider,
    model: config.model.model,
    ...(config.model.preset === null ? {} : { preset: config.model.preset }),
  },
  ...(config.tools === null
    ? {}
    : { tools: config.tools.allow === null ? {} : { allow: config.tools.allow } }),
  ...(Object.keys(config.plugins).length === 0 ? {} : { plugins: config.plugins }),
});

export const decodeConversation = (conversation: WireConversation): Conversation => ({
  id: conversation.id as ConversationId,
  workspaceRoot: conversation.workspaceRoot,
  overrides: conversation.overrides,
  head: conversation.head as ItemId | null,
  createdAt: conversation.createdAt,
  config: decodeConversationConfig(conversation.config),
});

export const decodeItem = (item: WireItem): Item => {
  const base = {
    id: item.id as ItemId,
    conversationId: item.conversationId as ConversationId,
    turnId: item.turnId as TurnId,
    seq: item.seq,
    parent: item.parent as ItemId | null,
    createdAt: item.createdAt,
  };
  switch (item.type) {
    case "message":
      return { ...base, type: item.type, role: item.role, content: item.content };
    case "reasoning":
    case "compaction":
      return { ...base, type: item.type, content: item.content };
    case "tool_call":
      return {
        ...base,
        type: item.type,
        callId: item.callId,
        name: item.name,
        args: item.args,
      };
    case "tool_result":
      return {
        ...base,
        type: item.type,
        callId: item.callId,
        content: item.content,
        status: item.status,
        ...(item.annotations === null ? {} : { annotations: item.annotations }),
      };
    case "context":
      return { ...base, type: item.type, content: item.content, key: item.key };
  }
};

export const decodeModelInfo = (model: WireModelInfo): ModelInfo => ({
  provider: model.provider,
  model: model.model,
  ...(model.label === null ? {} : { label: model.label }),
  ...(model.presets.length === 0
    ? {}
    : {
        presets: model.presets.map((preset) => ({
          value: preset.value,
          ...(preset.label === null ? {} : { label: preset.label }),
        })),
      }),
  ...(model.defaultPreset === null ? {} : { defaultPreset: model.defaultPreset }),
  ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
});

/** Core surface consumed by presentation clients; plugin controls extend it separately. */
export interface HarnessClientService {
  availableModels(): ModelInfo[];
  subscribe(id: ConversationId, listener: (event: HarnessEvent) => void): () => void;
  deliver(
    id: ConversationId,
    text: string,
    intent: "send" | "steer" | "queue" | "interrupt",
  ): Promise<void>;
  send(id: ConversationId, text: string): Promise<void>;
  compact(id: ConversationId): Promise<"compacted" | "noop">;
  setModel(id: ConversationId, model: { provider: string; model: string }): Promise<void>;
  setPreset(
    id: ConversationId,
    expected: { provider: string; model: string },
    preset: string | undefined,
  ): Promise<void>;
  setPluginConfig(
    id: ConversationId,
    pluginId: string,
    patch: Record<string, unknown>,
    options?: { saveGlobal?: boolean },
  ): Promise<void>;
}

/** Idiomatic TypeScript domain helper over the language-neutral wire client. */
export class HarnessDomainClient implements HarnessClientService {
  readonly #client: HarnessClient;
  readonly #listeners = new Map<ConversationId, Set<(event: HarnessEvent) => void>>();
  readonly #backlog = new Map<ConversationId, HarnessEvent[]>();
  readonly #subscribed = new Set<ConversationId>();
  readonly #attaching = new Set<ConversationId>();
  readonly #usage = new Map<ConversationId, ModelUsageSummary>();
  #backlogBytes = 0;
  #models: ModelInfo[] = [];
  #defaultModel: ConversationConfig["model"] = { provider: "demo", model: "demo-1" };

  constructor(client: HarnessClient) {
    this.#client = client;
    client.subscribe((event) => this.#receive(event));
  }

  async start(): Promise<void> {
    await this.#client.start();
    const catalog = await this.#client.models();
    this.#models = catalog.models.map(decodeModelInfo);
    this.#defaultModel = {
      provider: catalog.defaultModel.provider,
      model: catalog.defaultModel.model,
      ...(catalog.defaultModel.preset === null ? {} : { preset: catalog.defaultModel.preset }),
    };
  }

  availableModels(): ModelInfo[] {
    return this.#models;
  }

  defaultModel(): ConversationConfig["model"] {
    return this.#defaultModel;
  }

  async createConversation(options: { cwd?: string; overrides?: Record<string, unknown> } = {}) {
    return decodeConversation(
      await this.#client.create({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.overrides === undefined
          ? {}
          : { overrides: options.overrides as Record<string, never> }),
      }),
    );
  }

  async getConversation(id: ConversationId): Promise<Conversation | undefined> {
    const conversation = await this.#client.get(id);
    return conversation === null ? undefined : decodeConversation(conversation);
  }

  async listConversations(): Promise<Conversation[]> {
    const conversations: Conversation[] = [];
    let cursor: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = await this.#client.list({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      conversations.push(...page.conversations.map(decodeConversation));
      if (page.nextCursor === null) return conversations;
      cursor = page.nextCursor;
    }
  }

  async prepare(id: ConversationId): Promise<void> {
    await this.#client.attach(id);
  }

  async attachedConversation(id: ConversationId): Promise<Conversation> {
    const attachment = await this.#client.attach(id);
    return decodeConversation(attachment.root);
  }

  async getItems(id: ConversationId): Promise<Item[]> {
    const items: Item[] = [];
    let anchor: string | undefined;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#client.history({
        conversationId: id,
        ...(anchor === undefined ? {} : { anchor }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      anchor ??= page.anchor ?? undefined;
      items.push(
        ...(await Promise.all(
          page.entries.map(async (entry) =>
            decodeItem(entry.kind === "item" ? entry.item : await this.#client.readItem(id, entry)),
          ),
        )),
      );
      if (page.nextCursor === null) break;
      if (page.nextCursor === cursor) throw new Error("history cursor did not advance");
      cursor = page.nextCursor;
    }
    return items.reverse();
  }

  async usageSummary(id: ConversationId): Promise<ModelUsageSummary> {
    const cached = this.#usage.get(id);
    if (cached !== undefined) return cached;
    const summary = decodeUsageSummary(await this.#client.usage(id));
    this.#usage.set(id, summary);
    return summary;
  }

  subscribe(id: ConversationId, listener: (event: HarnessEvent) => void): () => void {
    this.#subscribed.add(id);
    let listeners = this.#listeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(id, listeners);
    }
    listeners.add(listener);
    const backlog = this.#backlog.get(id);
    if (backlog !== undefined) {
      this.#backlog.delete(id);
      for (const event of backlog) {
        this.#backlogBytes -= encodedLength(event);
        listener(event);
      }
    }
    this.#attaching.delete(id);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(id);
    };
  }

  async deliver(
    id: ConversationId,
    text: string,
    intent: "send" | "steer" | "queue" | "interrupt",
  ): Promise<void> {
    await this.#client.deliver(id, text, intent);
  }

  async send(id: ConversationId, text: string): Promise<void> {
    await this.deliver(id, text, "send");
  }

  async deactivateSession(id: ConversationId, options: { force?: boolean } = {}) {
    const result = await this.#client.close(id, options.force ?? false);
    return { status: result.status === "closed" ? ("deactivated" as const) : ("busy" as const) };
  }

  rewind(id: ConversationId, itemId: ItemId) {
    return this.#client.rewind(id, itemId);
  }

  async compact(id: ConversationId): Promise<"compacted" | "noop"> {
    return (await this.#client.compact(id)).status;
  }

  async deleteConversationIfEmpty(id: ConversationId): Promise<void> {
    await this.#client.deleteEmpty(id);
  }

  async setModel(id: ConversationId, model: { provider: string; model: string }): Promise<void> {
    await this.#client.setModel(id, model.provider, model.model);
  }

  async setPreset(
    id: ConversationId,
    expected: { provider: string; model: string },
    preset: string | undefined,
  ): Promise<void> {
    await this.#client.setPreset(id, expected, preset);
  }

  async setPluginConfig(
    id: ConversationId,
    pluginId: string,
    patch: Record<string, unknown>,
    options: { saveGlobal?: boolean } = {},
  ): Promise<void> {
    await this.#client.patchPluginConfig(
      id,
      pluginId,
      patch as Record<string, never>,
      options.saveGlobal ?? false,
    );
  }

  closeConnection(): void {
    this.#client.closeConnection();
  }

  #receive(event: HarnessClientEvent): void {
    if (event.type === "detached") {
      for (const raw of event.conversationIds) {
        const id = raw as ConversationId;
        this.#usage.delete(id);
        this.#attaching.delete(id);
        this.#replaceBacklog(id, []);
      }
      return;
    }
    if (event.type === "attached") {
      const rootId = event.attachment.root.id as ConversationId;
      const root = event.attachment.members.find(
        (member) => member.conversation.id === event.attachment.root.id,
      );
      if (root === undefined) throw new Error("attachment omitted its root live state");
      const snapshot: HarnessEvent[] = [
        { type: "inbox", conversationId: rootId, pending: root.live.pendingInput },
        {
          type: "usage.changed",
          conversationId: rootId,
          summary: decodeUsageSummary(event.attachment.usage),
        },
      ];
      this.#usage.set(rootId, decodeUsageSummary(event.attachment.usage));
      if (root.live.status === "running") {
        if (root.live.turnId === null) throw new Error("running attachment omitted its turn id");
        snapshot.push({
          type: "turn.status",
          conversationId: rootId,
          turnId: root.live.turnId as TurnId,
          status: "running",
        });
      }
      const listeners = this.#listeners.get(rootId);
      if (listeners !== undefined) {
        for (const current of snapshot) {
          for (const listener of listeners) listener(current);
        }
      } else {
        this.#replaceBacklog(rootId, snapshot);
        this.#attaching.add(rootId);
      }
      return;
    }
    const conversationId = event.conversationId as ConversationId;
    const translated = this.#translateEvent(conversationId, event.event);
    const listeners = this.#listeners.get(conversationId);
    if (listeners !== undefined) {
      for (const listener of listeners) listener(translated);
      return;
    }
    // Bridge only the initial attach/history race. A revisited background root
    // converges from durable history plus a fresh attach snapshot.
    if (this.#subscribed.has(conversationId) && !this.#attaching.has(conversationId)) return;
    const size = encodedLength(translated);
    if (this.#backlogBytes + size > MAX_BACKLOG_BYTES) {
      this.#client.peer.terminateProtocol("client event backlog exceeded its byte limit");
      return;
    }
    let backlog = this.#backlog.get(conversationId);
    if (backlog === undefined) {
      backlog = [];
      this.#backlog.set(conversationId, backlog);
    }
    backlog.push(translated);
    this.#backlogBytes += size;
  }

  #replaceBacklog(conversationId: ConversationId, events: HarnessEvent[]): void {
    for (const event of this.#backlog.get(conversationId) ?? []) {
      this.#backlogBytes -= encodedLength(event);
    }
    this.#backlog.set(conversationId, events);
    this.#backlogBytes += events.reduce((total, event) => total + encodedLength(event), 0);
  }

  #translateEvent(conversationId: ConversationId, event: WireConversationEvent): HarnessEvent {
    switch (event.type) {
      case "item.appended": {
        const item = decodeItem(event.item);
        return { type: "item.appended", conversationId, item };
      }
      case "turn.changed":
        return {
          type: "turn.status",
          conversationId,
          turnId: event.turnId as TurnId,
          status: event.status,
          ...(event.error === null ? {} : { error: event.error }),
        };
      case "input.changed":
        return { type: "inbox", conversationId, pending: event.pending };
      case "text.delta":
        return {
          type: "text_delta",
          conversationId,
          turnId: event.turnId as TurnId,
          text: event.text,
        };
      case "reasoning.delta":
        return {
          type: "reasoning_delta",
          conversationId,
          turnId: event.turnId as TurnId,
          text: event.text,
        };
      case "head.changed":
        return { type: "head.changed", conversationId, head: event.head as ItemId | null };
      case "config.changed":
        return {
          type: "config.changed",
          conversationId,
          config: decodeConversationConfig(event.config),
        };
      case "usage.changed": {
        const summary = decodeUsageSummary(event.summary);
        this.#usage.set(conversationId, summary);
        return { type: "usage.changed", conversationId, summary };
      }
    }
  }
}
