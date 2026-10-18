import { MCP_CLIENT_CONTRACT_VERSION } from "@harness/mcp/client";
import {
  HarnessClient,
  HarnessDomainClient,
  decodeConversation,
  decodeItem,
  decodeUsageSummary,
  type RpcConnection,
} from "@harness/client";
import { FEATURE_PLUGIN_CONTRACTS, HarnessPluginClient } from "@harness/client-features";
import { init, reduce } from "@harness/client-features/transcript-reducer";
import { ApprovalClient, APPROVAL_CLIENT_CONTRACT_VERSION } from "@harness/approval/client";
import {
  conversationProjectRoot,
  isKernelEvent,
  textOf,
  type Conversation,
  type ConversationId,
  type HistoryEntry,
  type Item,
  type JsonValue,
  type ModelConfig,
} from "@harness/protocol";
import {
  appAuthLoginRequest,
  appAuthUrlNotification,
  appSettingsRequest,
  appConversationProjectsRequest,
  appConversationListRequest,
  type AppSettings,
} from "@harness/server/client-protocol";
import { ConversationView } from "./conversation-view.ts";
export { ConversationView, type ConversationSnapshot } from "./conversation-view.ts";

type ConversationCursor = NonNullable<Awaited<ReturnType<HarnessClient["list"]>>["nextCursor"]>;
type Project = { workspaceRoot: string; lastUsedAt: number };
export interface SidebarPage<T, Cursor> {
  rows: T[];
  cursor: Cursor | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}
const emptyPage = <T, Cursor>(): SidebarPage<T, Cursor> => ({
  rows: [],
  cursor: null,
  loading: false,
  loaded: false,
  error: null,
});

/** Presentation lifetime is application-wide; route unmounts do not detach roots. */
export class DesktopSession {
  readonly client: HarnessClient;
  readonly domain: HarnessDomainClient;
  readonly plugins: HarnessPluginClient;
  readonly unread = new Set<ConversationId>();
  private activeConversation: ConversationId | null = null;
  readonly views = new Map<ConversationId, ConversationView>();
  private readonly listeners = new Set<() => void>();
  private readonly connectionListeners = new Set<() => void>();
  private readonly sidebarListeners = new Set<() => void>();
  private sidebarRevision = 0;
  readonly loads = new Map<string, Promise<ConversationView>>();
  private readonly historyLoads = new Map<ConversationView, Promise<void>>();
  private readonly subscriptions = new Map<string, Array<() => void>>();
  recents = emptyPage<Conversation, ConversationCursor>();
  projects = emptyPage<Project, Project>();
  readonly projectPages = new Map<string, SidebarPage<Conversation, ConversationCursor>>();
  settings: AppSettings | undefined;
  authUrl: string | undefined;
  authCode: string | null = null;
  private authAttempt: AbortController | undefined;
  private serverScope: string | undefined;
  disconnected: string | undefined;
  revision = 0;

  constructor(
    connection: RpcConnection,
    readonly hostScope = "local",
  ) {
    this.client = new HarnessClient({
      connection,
      client: { name: "harness-desktop", version: "0.1.0" },
      plugins: [
        { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
        { id: "mcp", version: MCP_CLIENT_CONTRACT_VERSION },
        ...FEATURE_PLUGIN_CONTRACTS,
      ],
      onProtocolError: (error) => this.disconnect(error.message),
    });
    const approvals = new ApprovalClient(this.client);
    this.plugins = new HarnessPluginClient(this.client, approvals);
    this.domain = new HarnessDomainClient(this.client);
    this.client.subscribe((event) => {
      if (event.type === "conversation" && event.event.type === "turn.changed") {
        for (const view of this.views.values()) {
          if (this.client.rootOf(view.conversation.id) === event.rootConversationId) {
            view.subagentRevision++;
            view.publish();
          }
        }
      }
      if (event.type !== "detached") return;
      for (const id of event.conversationIds) {
        for (const unsubscribe of this.subscriptions.get(id) ?? []) unsubscribe();
        this.subscriptions.delete(id);
        this.views.get(id as ConversationId)?.dispose();
        this.views.delete(id as ConversationId);
        this.unread.delete(id as ConversationId);
      }
      this.sidebarChanged();
    });
    this.client.peer.onNotification(appAuthUrlNotification, ({ url, userCode }) => {
      this.authUrl = url;
      this.authCode = userCode;
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
  subscribeConnection = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  };
  connectionSnapshot = (): string | undefined => this.disconnected;
  subscribeSidebar = (listener: () => void): (() => void) => {
    this.sidebarListeners.add(listener);
    return () => this.sidebarListeners.delete(listener);
  };
  sidebarSnapshot = (): number => this.sidebarRevision;
  private sidebarChanged(): void {
    this.sidebarRevision++;
    for (const listener of this.sidebarListeners) listener();
  }
  snapshot = (): number => this.revision;
  changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  setActiveConversation(id: ConversationId | null): void {
    this.activeConversation = id;
    if (id && this.unread.delete(id)) this.sidebarChanged();
  }

  disconnect(message: string): void {
    this.authAttempt?.abort();
    this.disconnected = message;
    for (const view of this.views.values()) view.publish();
    for (const listener of this.connectionListeners) listener();
    this.changed();
  }

  setServerScope(serverId: string): void {
    this.serverScope = serverId;
  }

  storageKey(key: string): string {
    if (this.serverScope === undefined) throw new Error("Server identity is not established");
    return `host:${this.hostScope}:${this.serverScope}:${key}`;
  }

  async start(): Promise<void> {
    await this.domain.start();
  }
  async readSettings(): Promise<AppSettings> {
    this.settings = await this.client.peer.request(appSettingsRequest, {});
    return this.settings;
  }

  async login(params: unknown, signal: AbortSignal): Promise<void> {
    if (this.authAttempt) throw new Error("A provider sign-in is already in progress");
    const attempt = new AbortController();
    this.authAttempt = attempt;
    try {
      await this.client.peer.request(
        appAuthLoginRequest,
        appAuthLoginRequest.params.parse(params),
        {
          signal: AbortSignal.any([signal, attempt.signal]),
        },
      );
    } finally {
      this.authAttempt = undefined;
      this.authUrl = undefined;
      this.authCode = null;
      this.changed();
    }
  }
  cancelLogin(): void {
    this.authAttempt?.abort();
  }
  async list(more = false): Promise<void> {
    if (!more) this.recents = emptyPage();
    await this.loadConversations(this.recents, 20);
  }

  private async loadConversations(
    page: SidebarPage<Conversation, ConversationCursor>,
    count: number,
    projectRoot?: string,
  ): Promise<void> {
    if (page.loading || (page.loaded && page.cursor === null)) return;
    page.loading = true;
    page.error = null;
    this.sidebarChanged();
    try {
      const rows: Conversation[] = [];
      let cursor = page.cursor;
      let remaining = count;
      do {
        const limit = Math.min(100, remaining);
        const result = await this.client.peer.request(appConversationListRequest, {
          limit,
          order: "lastUsed",
          cursor,
          filter: projectRoot === undefined ? null : { projectRoot },
        });
        rows.push(...result.conversations.map(decodeConversation));
        cursor = result.nextCursor;
        remaining -= limit;
      } while (remaining > 0 && cursor !== null);
      page.rows = [
        ...page.rows,
        ...rows.filter((row) => !page.rows.some((previous) => previous.id === row.id)),
      ];
      page.cursor = cursor;
      page.loaded = true;
    } catch (error) {
      page.error = error instanceof Error ? error.message : String(error);
    } finally {
      page.loading = false;
      this.sidebarChanged();
    }
  }

  async loadProjects(more = false, count = 50): Promise<void> {
    if (!more) this.projects = emptyPage();
    const page = this.projects;
    if (page.loading || (page.loaded && page.cursor === null)) return;
    page.loading = true;
    page.error = null;
    this.sidebarChanged();
    try {
      const rows: Project[] = [];
      let cursor = page.cursor;
      do {
        const result = await this.client.peer.request(appConversationProjectsRequest, {
          limit: Math.min(100, count - rows.length),
          cursor,
        });
        rows.push(...result.projects);
        cursor = result.nextCursor;
      } while (rows.length < count && cursor !== null);
      page.rows = [
        ...page.rows,
        ...rows.filter(
          (row) => !page.rows.some((previous) => previous.workspaceRoot === row.workspaceRoot),
        ),
      ];
      page.cursor = cursor;
      page.loaded = true;
    } catch (error) {
      page.error = error instanceof Error ? error.message : String(error);
    } finally {
      page.loading = false;
      this.sidebarChanged();
    }
  }

  async loadProject(workspaceRoot: string, more = false): Promise<void> {
    let page = this.projectPages.get(workspaceRoot);
    if (page?.loading) return;
    if (!page || !more) {
      page = emptyPage();
      this.projectPages.set(workspaceRoot, page);
    }
    await this.loadConversations(page, 5, workspaceRoot);
  }

  /** A sent message makes its conversation most-recent in place — no list refetch.
   * Order here is presentational; the server stays canonical on the next refetch. */
  private touchConversation(id: ConversationId): void {
    // Spawned children never appear in sidebar listings; leave them alone.
    if (this.client.rootOf(id) !== id) return;
    const conversation = this.views.get(id)?.conversation;
    if (!conversation) return;
    const front = (rows: Conversation[]): Conversation[] => {
      const index = rows.findIndex((row) => row.id === id);
      if (index <= 0) return index === 0 ? rows : [conversation, ...rows];
      return [rows[index]!, ...rows.slice(0, index), ...rows.slice(index + 1)];
    };
    this.recents.rows = front(this.recents.rows);
    const root = conversationProjectRoot(conversation);
    // Only reorder a loaded page; fabricating an entry would masquerade as a
    // complete list and suppress its real load.
    const page = root === null ? undefined : this.projectPages.get(root);
    if (page) page.rows = front(page.rows);
    this.sidebarChanged();
  }

  async refreshSidebar(): Promise<void> {
    const loaded = [...this.projectPages].map(
      ([root, page]) => [root, Math.max(5, page.rows.length)] as const,
    );
    const recentCount = Math.max(20, this.recents.rows.length);
    const projectCount = Math.max(50, this.projects.rows.length);
    this.recents = emptyPage();
    this.projectPages.clear();
    await Promise.all([
      this.loadConversations(this.recents, recentCount),
      this.loadProjects(false, projectCount),
      ...loaded.map(async ([root, count]) => {
        const page = emptyPage<Conversation, ConversationCursor>();
        this.projectPages.set(root, page);
        await this.loadConversations(page, count, root);
      }),
    ]);
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
    const view = new ConversationView(conversation, await this.plugins.inspectSubagent(id));
    this.views.set(id, view);
    const unsubscribeApproval = this.plugins.approvals.subscribe(id, (event) => {
      view.approvals = new Map(view.approvals);
      if (event.type === "created") view.approvals.set(event.approval.requestId, event.approval);
      else view.approvals.delete(event.requestId);
      view.publish();
      this.sidebarChanged();
    });
    const subscriptions = [unsubscribeApproval];
    this.subscriptions.set(id, subscriptions);
    try {
      const attachment = await this.client.attach(id);
      const member = attachment.members.find((member) => member.conversation.id === id);
      if (!member) throw new Error("Attachment omitted the requested conversation");
      view.conversation = decodeConversation(member.conversation);
      subscriptions.push(
        this.plugins.questions.subscribe(attachment.root.id, (event) => {
          if (event.type === "created") {
            if (event.request.conversationId !== id) return;
            view.questions = new Map(view.questions).set(event.request.id, event.request);
          } else {
            if (!view.questions.has(event.requestId)) return;
            view.questions = new Map(view.questions);
            view.questions.delete(event.requestId);
          }
          view.publish();
        }),
      );
      const page = await this.client.history({
        conversationId: id,
        ...(member.conversation.head ? { anchor: member.conversation.head } : {}),
        maxBytes: 128 * 1024,
      });
      view.anchor = page.anchor;
      view.cursor = page.nextCursor;
      view.items = await this.decodeHistory(id, page.entries);
      view.state = init(
        view.items,
        decodeUsageSummary(
          attachment.root.id === id ? attachment.usage : await this.client.usage(id),
        ),
      );
      view.publish();
      subscriptions.push(
        this.domain.subscribe(id, (event) => {
          const previousTurn = view.state.turn;
          const previousUnread = this.unread.has(id);
          if (
            this.activeConversation !== id &&
            isKernelEvent(event) &&
            ((event.type === "text_delta" && event.text.length > 0) ||
              (event.type === "item.appended" &&
                event.item.type === "message" &&
                event.item.role === "assistant" &&
                textOf(event.item.content).length > 0))
          )
            this.unread.add(id);

          if (isKernelEvent(event) && event.type === "workspace.changed") {
            view.conversation = {
              ...view.conversation,
              workspaceRoot: event.workspaceRoot,
              originalWorkspaceRoot: event.originalWorkspaceRoot,
            };
            void this.refreshSidebar();
          }
          if (isKernelEvent(event) && event.type === "title.changed") {
            view.conversation = { ...view.conversation, title: event.title };
            const titled = (row: Conversation): Conversation =>
              row.id === id ? { ...row, title: event.title } : row;
            this.recents.rows = this.recents.rows.map(titled);
            for (const page of this.projectPages.values()) page.rows = page.rows.map(titled);
          }
          if (isKernelEvent(event) && event.type === "config.changed")
            view.conversation = { ...view.conversation, config: event.config };
          if (isKernelEvent(event) && event.type === "item.appended") {
            const item = event.item;
            if (!view.items.some((current) => current.id === item.id)) view.items.push(item);
            if (item.type === "message" && item.role === "user") this.touchConversation(id);
          }
          view.state = reduce(view.state, event, Date.now());
          view.publish(
            isKernelEvent(event) &&
              (event.type === "text_delta" || event.type === "reasoning_delta"),
          );
          if (
            previousTurn.status !== view.state.turn.status ||
            previousUnread !== this.unread.has(id) ||
            (isKernelEvent(event) &&
              (event.type === "title.changed" ||
                event.type === "workspace.changed" ||
                (event.type === "item.appended" &&
                  event.item.type === "message" &&
                  event.item.role === "user")))
          )
            this.sidebarChanged();
        }),
      );
      subscriptions.push(
        this.plugins.subscribe(attachment.root.id as ConversationId, (event) => {
          if (event.type === "activity.started" || event.type === "activity.exited")
            view.subagentRevision++;
          view.state = reduce(view.state, event, Date.now());
          view.publish();
        }),
      );
      view.publish();
      this.sidebarChanged();
      return view;
    } catch (error) {
      for (const unsubscribe of subscriptions) unsubscribe();
      this.subscriptions.delete(id);
      view.dispose();
      this.views.delete(id);
      this.sidebarChanged();
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
    const pending = this.historyLoads.get(view);
    if (pending) return pending;
    // Route remounts share a view; reload creates a new view with its own cursor load.
    const result = this.loadOlder(view).finally(() => this.historyLoads.delete(view));
    this.historyLoads.set(view, result);
    return result;
  }

  private async loadOlder(view: ConversationView): Promise<void> {
    if (view.cursor === null) return;
    const id = view.conversation.id;
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
    view.publish();
  }

  async create(
    cwd: string,
    model: string,
    sandbox: string,
    toolMode: string,
    preset: string,
    newWorktree = false,
  ): Promise<string> {
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
    const overrides: Record<string, JsonValue> = {
      instructions: "You are a helpful coding agent.",
      model: { provider, model: modelId, ...(preset ? { preset } : {}) } satisfies ModelConfig,
      tools: { mode: toolMode },
      plugins: { sandbox: { backend: sandbox } },
    };
    const conversation = decodeConversation(
      newWorktree
        ? await this.plugins.createWorktreeConversation(cwd, overrides)
        : await this.client.create({ cwd, overrides }),
    );
    await this.refreshSidebar();
    return conversation.id;
  }
}
