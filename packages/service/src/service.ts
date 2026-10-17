import { realpath } from "node:fs/promises";
import { WorkspaceOperationError } from "@harness/protocol";
import type {
  ConversationConfig,
  NewConversationRecord,
  CodeEvaluator,
  Conversation,
  ConversationId,
  ConversationPageCursor,
  ConversationListOptions,
  ConversationProject,
  ConversationProjectCursor,
  ConversationRecord,
  ConversationRunner,
  DeliveryInput,
  DeliveryIntent,
  HarnessEvent,
  Item,
  ItemId,
  ModelIdentityChange,
  ModelIdentity,
  ModelInfo,
  ModelUsage,
  ModelUsageSummary,
  Plugin,
  PluginEntry,
  Store,
  WorktreeOperations,
  WorkspaceSelection,
} from "@harness/protocol";
import { isPluginDefinition } from "@harness/protocol";
import { Engine, PluginHost, type DeactivationResult } from "@harness/core";
import {
  defaultHome,
  resolveSettings,
  ResolvedConfigReader,
  updateGlobalModel,
  updateGlobalPluginConfig,
  deepMerge,
  type SettingsDoc,
} from "@harness/config";
import type { ZodType } from "zod";

export interface HarnessServiceOptions {
  store: Store;
  /** Plain plugins, plus config-owning `PluginDefinition`s (validated centrally). */
  plugins: PluginEntry[];
  /** Harness home directory (global settings; later the db root). Defaults to `~/.harness`. */
  home?: string;
  /**
   * Lowest-precedence base layer, below all settings files (e.g. a CLI fallback model). Held on the
   * service (not per-create) so it re-applies on every resolve, including resume — a fallback means
   * resolution can never fail "no model configured".
   */
  defaults?: SettingsDoc;
  codeEvaluator: CodeEvaluator;
  worktrees?: WorktreeOperations;
  removeWorkspaceEnvironment?: (path: string) => Promise<void>;
}

export interface CreateConversationOptions {
  /** Project search root; absent ⇒ projectless (no project settings, no workspace). */
  cwd?: string;
  newWorktree?: boolean;
  signal?: AbortSignal;
  /**
   * The conversation's durable `overrides` (top cascade layer), e.g. a CLI-chosen model or seed
   * instructions. Re-applied on every resolve, so it survives resume.
   */
  overrides?: Record<string, unknown>;
  /** Parent for a plugin-spawned child; absent creates a new root conversation. */
  parentId?: ConversationId;
}

export type EventListener = (event: HarnessEvent) => void;

/**
 * The single façade every client calls: typed events out, one delivery seam in.
 * Holds no control state — that lives in the loop and the log. Owns config
 * resolution: it builds the plugin schema registry and resolves the settings
 * cascade into each conversation's initial config at creation.
 */
export class HarnessService implements ConversationRunner {
  readonly #store: Store;
  readonly #worktrees: WorktreeOperations | undefined;
  readonly #removeWorkspaceEnvironment: ((path: string) => Promise<void>) | undefined;
  readonly #engine: Engine;
  readonly #home: string;
  readonly #schemas = new Map<string, ZodType>();
  readonly #globalPlugins = new Set<string>();
  readonly #inheritedPlugins = new Set<string>();
  #configMutation: Promise<void> = Promise.resolve();
  readonly #resolveConfig: (record: NewConversationRecord) => Promise<ConversationConfig>;

  constructor(options: HarnessServiceOptions) {
    this.#store = options.store;
    this.#worktrees = options.worktrees;
    this.#removeWorkspaceEnvironment = options.removeWorkspaceEnvironment;
    this.#home = options.home ?? defaultHome();
    const defaults = options.defaults;
    // Safe to close over `#schemas`: the plugin loop below populates it before this is ever
    // invoked (at load/create time).
    this.#resolveConfig = (record) =>
      resolveSettings({
        home: this.#home,
        schemas: this.#schemas,
        globalPlugins: this.#globalPlugins,
        ...(defaults !== undefined ? { defaults } : {}),
        ...((record.originalWorkspaceRoot ?? record.workspaceRoot) !== null
          ? { cwd: record.originalWorkspaceRoot ?? record.workspaceRoot! }
          : {}),
        overrides: record.overrides,
      });
    // Late-binds `#engine.configFor` — `#engine` is assigned below, before any tool call (the only
    // caller) can run.
    const reader = new ResolvedConfigReader(this.#store, this.#resolveConfig, (id) =>
      this.#engine.configFor(id),
    );
    const plugins: Plugin[] = [];
    for (const entry of options.plugins) {
      if (isPluginDefinition(entry)) {
        this.#schemas.set(entry.id, entry.configSchema);
        if (entry.configScope === "global") this.#globalPlugins.add(entry.id);
        if (entry.inheritConfig) this.#inheritedPlugins.add(entry.id);
        plugins.push(entry.create(reader));
      } else {
        plugins.push(entry);
      }
    }
    this.#engine = new Engine(
      this.#store,
      new PluginHost(plugins),
      this.#resolveConfig,
      options.codeEvaluator,
    );
  }

  /**
   * Persists a new conversation record (its workspace + durable overrides) and returns it with its
   * freshly resolved config. Config is never stored — it is re-derived on every load.
   */
  async createConversation(options: CreateConversationOptions = {}): Promise<Conversation> {
    const cwd = options.cwd ? await realpath(options.cwd) : undefined;
    let overrides = options.overrides ?? {};
    if (options.parentId !== undefined) {
      const parent = this.#engine.configFor(options.parentId);
      if (!parent) throw new Error(`cannot create a child for inactive parent ${options.parentId}`);
      const plugins = Object.fromEntries(
        [...this.#inheritedPlugins].map((id) => [id, parent.plugins?.[id]]),
      );
      overrides = deepMerge(
        {
          model: parent.model,
          ...(parent.tools?.mode ? { tools: { mode: parent.tools.mode } } : {}),
          plugins,
        },
        overrides,
      ) as Record<string, unknown>;
    }
    const parentRecord = options.parentId
      ? await this.#store.getConversation(options.parentId)
      : undefined;
    const owned = cwd ? await this.#store.getManagedWorktree(cwd) : undefined;
    const originalWorkspaceRoot = parentRecord?.originalWorkspaceRoot ?? owned?.repository;
    const input = {
      workspaceRoot: cwd ?? null,
      overrides,
      ...(originalWorkspaceRoot ? { originalWorkspaceRoot } : {}),
    };
    const config = await this.#resolveConfig(input);
    if (options.newWorktree) {
      if (!cwd || options.parentId)
        throw new Error("New worktree requires a top-level conversation with a Git checkout");
      const tree = await this.#worktreeOperations().create(cwd, options.signal);
      input.originalWorkspaceRoot = originalWorkspaceRoot ?? cwd;
      input.workspaceRoot = tree.path;
    }
    // Insert the complete selection atomically; global model defaults only select new records.
    const record = await this.#store.createConversation({
      ...input,
      overrides: { ...overrides, model: config.model },
    });
    try {
      if (options.parentId !== undefined) this.#engine.registerChild(options.parentId, record.id);
      return { ...record, config };
    } catch (error) {
      await this.#store.deleteConversationIfEmpty(record.id);
      throw error;
    }
  }

  worktreeRepository(path: string) {
    return this.#worktreeOperations().repository(path);
  }

  async workspaceOptions(conversationId: ConversationId) {
    const record = await this.#store.getConversation(conversationId);
    if (!record?.workspaceRoot) throw new WorkspaceOperationError("Conversation has no workspace");
    const original = record.originalWorkspaceRoot ?? record.workspaceRoot;
    if ((await this.#worktreeOperations().repository(original)) === null) return null;
    return {
      original,
      current: record.workspaceRoot,
      worktrees: await this.#worktreeOperations().list(original),
    };
  }

  async selectWorkspace(
    conversationId: ConversationId,
    selection: WorkspaceSelection,
    deferred = false,
    signal?: AbortSignal,
  ) {
    const record = await this.#store.getConversation(conversationId);
    if (!record?.workspaceRoot) throw new WorkspaceOperationError("Conversation has no workspace");
    if (!deferred && this.isSessionBusy(this.rootConversationOf(conversationId)))
      throw new WorkspaceOperationError(
        "Stop the conversation and background work before switching workspaces",
      );
    const original = record.originalWorkspaceRoot ?? record.workspaceRoot;
    const manager = this.#worktreeOperations();
    let path = record.workspaceRoot;
    await this.#engine.switchWorkspace(
      conversationId,
      async (operationSignal) => {
        if (selection.kind === "original") path = original;
        else if (selection.kind === "new")
          path = (await manager.create(record.workspaceRoot!, operationSignal, selection.branch))
            .path;
        else {
          const tree = (await manager.list(original)).find((tree) => tree.path === selection.path);
          if (!tree)
            throw new WorkspaceOperationError("Selected worktree belongs to another repository");
          path = tree.path;
        }
        await manager.inspect(path);
        return path;
      },
      deferred,
      signal,
    );
    return { path, deferred };
  }

  runWorkspaceOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    return this.#engine.runWorkspaceOperation(path, operation);
  }

  async removeWorktree(path: string, force: boolean): Promise<void> {
    await this.#engine.deleteWorkspace(path, async () => {
      await this.#worktreeOperations().validateRemoval(path, force);
      await this.#removeWorkspaceEnvironment?.(path);
      await this.#worktreeOperations().remove(path, force);
    });
  }

  managedWorktrees(limit: number, before?: string) {
    return this.#worktreeOperations().managed(limit, before);
  }

  #worktreeOperations(): WorktreeOperations {
    if (!this.#worktrees) throw new Error("Worktree support is not configured");
    return this.#worktrees;
  }

  async forkBefore(conversationId: ConversationId, userMessageId: ItemId) {
    const source = await this.#store.getConversation(conversationId);
    if (!source) throw new Error(`unknown conversation: ${conversationId}`);
    const { config, toolNames } = await this.#engine.forkSettings(conversationId);
    const overrides = {
      model: config.model,
      instructions: config.instructions,
      tools: { mode: config.tools?.mode ?? "hybrid", allow: toolNames },
      plugins: Object.fromEntries(
        Object.entries(config.plugins ?? {}).filter(([id]) => !this.#globalPlugins.has(id)),
      ),
    };
    const resolved = await this.#resolveConfig({
      workspaceRoot: source.workspaceRoot,
      ...(source.originalWorkspaceRoot
        ? { originalWorkspaceRoot: source.originalWorkspaceRoot }
        : {}),
      overrides,
    });
    const record = await this.#store.forkConversation(conversationId, userMessageId, overrides);
    const user = await this.#store.getItem(userMessageId);
    if (user?.type !== "message" || user.role !== "user")
      throw new Error("fork lost its immutable user message");
    return { conversation: { ...record, config: resolved }, draft: user.content };
  }

  /** Pair a durable record with its freshly resolved config — the resolved view clients consume. */
  async #resolve(record: ConversationRecord): Promise<Conversation> {
    return { ...record, config: await this.#resolveConfig(record) };
  }

  /**
   * Warms a conversation's runtime and execution backend before its first turn, so pre-turn
   * `!cmd`/`/sandbox` work and lazy sandbox provisioning can stream progress. Idempotent.
   */
  async prepare(conversationId: ConversationId): Promise<void> {
    return this.#engine.prepare(conversationId);
  }

  /**
   * Delivers user text with the given intent (`send`/`steer`/`queue`/`interrupt`).
   * Resolves once it is accepted, not once its turn completes. An empty-text
   * `interrupt` is a pure abort (no message seeds the next turn).
   */
  async deliver(
    conversationId: ConversationId,
    text: string | DeliveryInput,
    intent: DeliveryIntent,
  ): Promise<void> {
    return this.#engine.deliver(
      conversationId,
      typeof text === "string"
        ? { source: { kind: "user" }, content: text ? [{ type: "text", text }] : [] }
        : text,
      intent,
    );
  }

  /** Sugar for `deliver(id, text, "send")`. */
  send(conversationId: ConversationId, text: string): Promise<void> {
    return this.deliver(conversationId, text, "send");
  }

  /**
   * Answers a pending middleware request (e.g. an approval prompt) raised via
   * `ctx.request` and surfaced as a `request.created` event. A no-op if the request
   * is no longer pending.
   */
  respond(conversationId: ConversationId, requestId: string, response: unknown): void {
    this.#engine.respond(conversationId, requestId, response);
  }

  /**
   * Moves the conversation's head to an earlier item (linear rewind). The next
   * `deliver` continues from there. Throws if a turn is running.
   */
  rewind(conversationId: ConversationId, toItemId: ItemId): Promise<void> {
    return this.#engine.rewind(conversationId, toItemId);
  }

  /** Runs an explicit summary-only compaction while the conversation is idle. */
  compact(conversationId: ConversationId, signal?: AbortSignal): Promise<"compacted" | "noop"> {
    return this.#engine.compact(conversationId, signal);
  }

  /** Resolves when the conversation has no running or queued work. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#engine.whenIdle(conversationId);
  }

  /**
   * Releases the active top-level conversation and every loaded descendant runtime. By default an
   * active/queued root is left untouched; process shutdown may force cancellation.
   */
  deactivateSession(
    rootConversationId: ConversationId,
    options: { force?: boolean } = {},
  ): Promise<DeactivationResult> {
    return this.#engine.deactivate(rootConversationId, options);
  }

  /** Requests prompt cancellation while leaving disposal to `deactivateSession`. */
  cancelSession(rootConversationId: ConversationId): void {
    this.#engine.cancel(rootConversationId);
  }

  /** Aggregate model catalog across registered providers. */
  availableModels(): ModelInfo[] {
    return this.#engine.availableModels();
  }

  /**
   * Switches the conversation's model and persists it as the global default for future
   * conversations. The conversation switch goes first so its `config.changed` is emitted
   * before the global write can fail.
   */
  async setModel(conversationId: ConversationId, identity: ModelIdentityChange): Promise<void> {
    await this.#serializeConfigMutation(async () => {
      const model = await this.#engine.setModel(conversationId, identity);
      await updateGlobalModel(this.#home, model);
    });
  }

  setTitle(conversationId: ConversationId, title: string): Promise<void> {
    return this.#engine.setTitle(conversationId, title);
  }

  /** Changes the current model's preset without allowing model identity to change. */
  async setPreset(
    conversationId: ConversationId,
    expected: ModelIdentity,
    preset: string | undefined,
  ): Promise<void> {
    await this.#serializeConfigMutation(async () => {
      const model = await this.#engine.setPreset(conversationId, expected, preset);
      await updateGlobalModel(this.#home, model);
    });
  }

  #serializeConfigMutation(mutate: () => Promise<void>): Promise<void> {
    const result = this.#configMutation.then(mutate, mutate);
    this.#configMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Deep-patches one plugin slice in this conversation's durable override layer.
   * With `saveGlobal`, the same patch also becomes the default for other conversations.
   */
  async setPluginConfig(
    conversationId: ConversationId,
    pluginId: string,
    patch: Record<string, unknown>,
    options: { saveGlobal?: boolean } = {},
  ): Promise<void> {
    return this.#serializeConfigMutation(async () => {
      if (this.#globalPlugins.has(pluginId)) throw new Error(`plugin '${pluginId}' is global-only`);
      const schema = this.#schemas.get(pluginId);
      if (!schema) throw new Error(`unknown plugin '${pluginId}'`);
      const record = await this.#store.getConversation(conversationId);
      if (!record) throw new Error(`unknown conversation: ${conversationId}`);
      const current = await this.#resolve(record);
      const effective = current.config.plugins?.[pluginId] ?? {};
      const checked = schema.safeParse(deepMerge(effective, patch));
      if (!checked.success) {
        throw new Error(`invalid config for plugin '${pluginId}'`);
      }

      // Global first: the subsequent conversation re-resolution sees the newly saved defaults.
      if (options.saveGlobal) {
        await updateGlobalPluginConfig(this.#home, pluginId, patch);
      }

      const overridesPlugins =
        record.overrides.plugins &&
        typeof record.overrides.plugins === "object" &&
        !Array.isArray(record.overrides.plugins)
          ? (record.overrides.plugins as Record<string, unknown>)
          : {};
      const overrideSlice = overridesPlugins[pluginId] ?? {};
      await this.#engine.updatePluginOverrides(conversationId, {
        ...overridesPlugins,
        [pluginId]: deepMerge(overrideSlice, patch),
      });
    });
  }

  /** Apply explicitly selected default slices to loaded runtimes, preserving durable overrides. */
  async refreshPluginDefaults(pluginIds: readonly string[]): Promise<void> {
    for (const id of pluginIds) {
      if (!this.#schemas.has(id)) throw new Error(`unknown plugin '${id}'`);
    }
    await this.#serializeConfigMutation(() => this.#engine.refreshPluginDefaults(pluginIds));
  }

  /**
   * Subscribes to the typed event stream. With a `conversationId`, receives only that
   * conversation's events; without one, receives every event. Returns an unsubscribe handle.
   */
  subscribe(listener: EventListener): () => void;
  subscribe(conversationId: ConversationId, listener: EventListener): () => void;
  subscribe(a: EventListener | ConversationId, b?: EventListener): () => void {
    if (typeof a === "function") return this.#engine.subscribe({ onEvent: a });
    return this.#engine.subscribe({ onEvent: b! }, a);
  }

  /**
   * Resolve a per-conversation plugin service for a client read — the same instance tools
   * see via `ctx.service` (e.g. the TUI reading the `"activities"` manager). `undefined` when
   * the conversation has no live runtime yet or no plugin owns `key`. Opaque: narrow it client-side.
   */
  service(conversationId: ConversationId, key: string): unknown {
    return this.#engine.serviceFor(conversationId, key);
  }

  /** Read an already-created service without introducing work during an attach snapshot. */
  existingService(conversationId: ConversationId, key: string): unknown {
    return this.#engine.existingServiceFor(conversationId, key);
  }

  /** One conversation by id, with its config resolved on read. Backs session resume. */
  async getConversation(id: ConversationId): Promise<Conversation | undefined> {
    const record = await this.#store.getConversation(id);
    if (!record) return undefined;
    return this.#resolve(record);
  }

  /** Drops a conversation a client created but left empty (head null, no turns). */
  deleteConversationIfEmpty(id: ConversationId): Promise<void> {
    return this.#store.deleteConversationIfEmpty(id);
  }

  /**
   * All conversations, most-recent-first, each with its config resolved. Resolution is per-record
   * and defensive: one conversation whose project `settings.json` is broken (invalid JSON, unknown
   * plugin, no model) is skipped rather than breaking the whole picker.
   */
  async listConversations(): Promise<Conversation[]> {
    const records = await this.#store.listConversations();
    const out: Conversation[] = [];
    for (const record of records) {
      try {
        out.push(await this.#resolve(record));
      } catch {
        // Unresolvable (and thus unloadable) until its settings are fixed — omit from the listing.
      }
    }
    return out;
  }

  /** The active item chain (head's ancestry) — the render/resume source for a conversation. */
  getItems(id: ConversationId): Promise<Item[]> {
    return this.#store.listActiveItems(id);
  }

  listConversationPage(
    limit: number,
    before?: ConversationPageCursor,
    options?: ConversationListOptions,
  ): Promise<ConversationRecord[]> {
    return this.#store.listConversationPage(limit, before, options);
  }

  listConversationProjects(
    limit: number,
    before?: ConversationProjectCursor,
    excludedState?: { plugin: string; key: string },
  ): Promise<ConversationProject[]> {
    return this.#store.listConversationProjects(limit, before, excludedState);
  }

  getLatestTurn(id: ConversationId) {
    return this.#store.getLatestTurn(id);
  }

  getItem(itemId: ItemId): Promise<Item | undefined> {
    return this.#store.getItem(itemId);
  }

  listItemAncestors(start: ItemId | null, limit: number): Promise<Item[]> {
    return this.#store.listItemAncestors(start, limit);
  }

  usageSummary(id: ConversationId): Promise<ModelUsageSummary> {
    return this.#store.summarizeModelUsage(id);
  }

  registerChild(parent: ConversationId, child: ConversationId): void {
    this.#engine.registerChild(parent, child);
  }

  isConversationRunning(id: ConversationId): boolean {
    return this.#engine
      .conversationTreeState(id)
      .some((member) => member.conversation.id === id && member.status === "running");
  }

  conversationTreeState(rootId: ConversationId) {
    return this.#engine.conversationTreeState(rootId);
  }

  isSessionBusy(rootId: ConversationId): boolean {
    return this.#engine.isSessionBusy(rootId);
  }

  pendingRequests(rootId: ConversationId) {
    return this.#engine.pendingRequests(rootId);
  }

  rootConversationOf(conversationId: ConversationId): ConversationId {
    return this.#engine.rootConversationOf(conversationId);
  }

  /** Per-request usage/cost rows, in record order. Backs resume footer totals. */
  usage(id: ConversationId): Promise<ModelUsage[]> {
    return this.#store.listModelUsage(id);
  }

  /** Durable per-conversation plugin metadata — the `ConversationRunner` seam, forwarded to the store. */
  putPluginState(
    plugin: string,
    id: ConversationId,
    key: string,
    value: unknown,
    scope?: string,
  ): Promise<void> {
    return this.#store.putPluginState(plugin, id, key, value, scope);
  }

  getPluginState(plugin: string, id: ConversationId, key: string): Promise<unknown> {
    return this.#store.getPluginState(plugin, id, key);
  }
}
