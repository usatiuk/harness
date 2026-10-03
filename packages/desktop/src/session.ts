import {
  HarnessClient,
  HarnessDomainClient,
  decodeConversation,
  decodeItem,
  decodeUsageSummary,
  type RpcConnection,
} from "@harness/client";
import { FEATURE_PLUGIN_CONTRACTS, HarnessPluginClient } from "@harness/client-features";
import { init, reduce, type State } from "@harness/client-features/transcript-reducer";
import {
  ApprovalClient,
  APPROVAL_CLIENT_CONTRACT_VERSION,
  type ClientApproval,
} from "@harness/approval/client";
import {
  isKernelEvent,
  type Conversation,
  type ConversationId,
  type HistoryEntry,
  type Item,
  type JsonValue,
} from "@harness/protocol";
import {
  appAuthUrlNotification,
  appSettingsRequest,
  type AppSettings,
} from "@harness/server/client-protocol";

export interface ConversationView {
  conversation: Conversation;
  state: State;
  approvals: Map<string, ClientApproval>;
  items: Item[];
  anchor: string | null;
  cursor: string | null;
}

/** Presentation lifetime is application-wide; route unmounts do not detach roots. */
export class DesktopSession {
  readonly client: HarnessClient;
  readonly domain: HarnessDomainClient;
  readonly plugins: HarnessPluginClient;
  readonly views = new Map<ConversationId, ConversationView>();
  readonly listeners = new Set<() => void>();
  readonly loads = new Map<string, Promise<ConversationView>>();
  private readonly subscriptions = new Map<string, Array<() => void>>();
  conversations: Conversation[] = [];
  listLoaded = false;
  listCursor: { createdAt: number; id: string } | null = null;
  settings: AppSettings | undefined;
  authUrl: string | undefined;
  disconnected: string | undefined;
  revision = 0;

  constructor(connection: RpcConnection) {
    this.client = new HarnessClient({
      connection,
      client: { name: "harness-desktop", version: "0.1.0" },
      plugins: [
        { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
        ...FEATURE_PLUGIN_CONTRACTS,
      ],
      onProtocolError: (error) => this.disconnect(error.message),
    });
    const approvals = new ApprovalClient(this.client.peer);
    this.plugins = new HarnessPluginClient(this.client, approvals);
    this.domain = new HarnessDomainClient(this.client);
    this.client.subscribe((event) => {
      if (event.type !== "detached") return;
      for (const id of event.conversationIds) {
        for (const unsubscribe of this.subscriptions.get(id) ?? []) unsubscribe();
        this.subscriptions.delete(id);
        this.views.delete(id as ConversationId);
      }
      this.changed();
    });
    this.client.peer.onNotification(appAuthUrlNotification, ({ url }) => {
      this.authUrl = url;
      this.changed();
    });
    connection.onClose(() => this.disconnect(this.disconnected ?? "Harness server disconnected"));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): number => this.revision;
  changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  disconnect(message: string): void {
    this.disconnected = message;
    this.changed();
  }

  async start(): Promise<void> {
    await this.domain.start();
  }
  async readSettings(): Promise<AppSettings> {
    this.settings = await this.client.peer.request(appSettingsRequest, {});
    return this.settings;
  }
  async list(more = false): Promise<void> {
    const page = await this.client.list({
      limit: 50,
      ...(more && this.listCursor ? { cursor: this.listCursor } : {}),
    });
    const topLevel = await this.plugins.topLevel(
      page.conversations.map((row) => row.id as ConversationId),
    );
    const rows = page.conversations
      .filter((row) => topLevel.has(row.id as ConversationId))
      .map(decodeConversation);
    this.conversations = more
      ? [
          ...this.conversations,
          ...rows.filter((row) => !this.conversations.some((current) => current.id === row.id)),
        ]
      : rows;
    for (const { conversation } of this.views.values()) {
      if (!this.conversations.some((row) => row.id === conversation.id))
        this.conversations.unshift(conversation);
    }
    this.listCursor = page.nextCursor;
    this.listLoaded = true;
    this.changed();
  }

  load(raw: string): Promise<ConversationView> {
    const id = raw as ConversationId;
    const current = this.views.get(id);
    const pending = this.loads.get(id);
    if (pending) return pending;
    if (current) return Promise.resolve(current);
    const result = this.attach(id);
    this.loads.set(id, result);
    void result.finally(() => this.loads.delete(id)).catch(() => undefined);
    return result;
  }

  private async attach(id: ConversationId): Promise<ConversationView> {
    const conversation = await this.domain.getConversation(id);
    if (!conversation) throw new Error("Conversation does not exist");
    const view: ConversationView = {
      conversation,
      state: init([]),
      approvals: new Map(),
      items: [],
      anchor: null,
      cursor: null,
    };
    this.views.set(id, view);
    const unsubscribeApproval = this.plugins.approvals.subscribe(id, (event) => {
      if (event.type === "created") view.approvals.set(event.approval.requestId, event.approval);
      else view.approvals.delete(event.requestId);
      this.changed();
    });
    const subscriptions = [unsubscribeApproval];
    this.subscriptions.set(id, subscriptions);
    try {
      const attachment = await this.client.attach(id);
      view.conversation = decodeConversation(attachment.root);
      const page = await this.client.history({
        conversationId: id,
        ...(attachment.root.head ? { anchor: attachment.root.head } : {}),
        maxBytes: 128 * 1024,
      });
      view.anchor = page.anchor;
      view.cursor = page.nextCursor;
      view.items = await this.decodeHistory(id, page.entries);
      view.state = init(view.items, decodeUsageSummary(attachment.usage));
      subscriptions.push(
        this.domain.subscribe(id, (event) => {
          if (isKernelEvent(event) && event.type === "config.changed")
            view.conversation = { ...view.conversation, config: event.config };
          if (isKernelEvent(event) && event.type === "item.appended") {
            const item = event.item;
            if (!view.items.some((current) => current.id === item.id)) view.items.push(item);
          }
          view.state = reduce(view.state, event, Date.now());
          this.changed();
        }),
      );
      subscriptions.push(
        this.plugins.subscribe(id, (event) => {
          view.state = reduce(view.state, event, Date.now());
          this.changed();
        }),
      );
      this.changed();
      return view;
    } catch (error) {
      for (const unsubscribe of subscriptions) unsubscribe();
      this.subscriptions.delete(id);
      this.views.delete(id);
      this.changed();
      throw error;
    }
  }

  private async decodeHistory(id: string, entries: HistoryEntry[]): Promise<Item[]> {
    const items: Item[] = [];
    for (const entry of entries)
      items.push(
        decodeItem(entry.kind === "item" ? entry.item : await this.client.readItem(id, entry)),
      );
    return items.reverse();
  }

  async older(id: string): Promise<void> {
    const view = await this.load(id);
    if (view.cursor === null) return;
    const page = await this.client.history({
      conversationId: id,
      ...(view.anchor ? { anchor: view.anchor } : {}),
      cursor: view.cursor,
      maxBytes: 128 * 1024,
    });
    view.items = [...(await this.decodeHistory(id, page.entries)), ...view.items];
    view.cursor = page.nextCursor;
    const seed = init(view.items);
    // Keep the live suffix, status and accounting while prepending older facts.
    const known = new Set(
      view.state.cells.flatMap((cell) =>
        "id" in cell && cell.id ? [cell.id] : cell.kind === "tool" ? [cell.callId] : [],
      ),
    );
    view.state = {
      ...view.state,
      cells: [
        ...seed.cells.filter((cell) => {
          const key = "id" in cell ? cell.id : cell.kind === "tool" ? cell.callId : undefined;
          return key !== undefined && !known.has(key);
        }),
        ...view.state.cells,
      ],
      itemIds: seed.itemIds,
    };
    this.changed();
  }

  async create(cwd: string, model: string, sandbox: string): Promise<string> {
    const [provider, modelId] = model.split("\u0000");
    if (!provider || !modelId) throw new Error("Select a model");
    if (
      !this.domain
        .availableModels()
        .some((entry) => entry.provider === provider && entry.model === modelId)
    )
      throw new Error(
        "The selected model is unavailable; connect its provider and restart Harness",
      );
    const defaultModel = this.settings?.settings.model ?? this.domain.defaultModel();
    const preset =
      defaultModel.provider === provider && defaultModel.model === modelId
        ? defaultModel.preset
        : undefined;
    const overrides: Record<string, JsonValue> = {
      instructions: "You are a helpful coding agent.",
      model: { provider, model: modelId, ...(preset ? { preset } : {}) },
      plugins: { sandbox: { backend: sandbox } },
    };
    const conversation = decodeConversation(await this.client.create({ cwd, overrides }));
    this.conversations.unshift(conversation);
    this.changed();
    return conversation.id;
  }
}
