import type {
  ConfigResolver,
  Conversation,
  ConversationId,
  ConversationPageCursor,
  ConversationRecord,
  ConversationRunner,
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
}

export interface CreateConversationOptions {
  /** Project search root; absent ⇒ projectless (no project settings, no workspace). */
  cwd?: string;
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
  readonly #engine: Engine;
  readonly #home: string;
  readonly #schemas = new Map<string, ZodType>();
  readonly #inheritedPlugins = new Set<string>();
  #configMutation: Promise<void> = Promise.resolve();
  readonly #resolveConfig: ConfigResolver;

  constructor(options: HarnessServiceOptions) {
    this.#store = options.store;
    this.#home = options.home ?? defaultHome();
    const defaults = options.defaults;
    // Safe to close over `#schemas`: the plugin loop below populates it before this is ever
    // invoked (at load/create time).
    this.#resolveConfig = (record) =>
      resolveSettings({
        home: this.#home,
        schemas: this.#schemas,
        ...(defaults !== undefined ? { defaults } : {}),
        ...(record.workspaceRoot !== null ? { cwd: record.workspaceRoot } : {}),
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
        if (entry.inheritConfig) this.#inheritedPlugins.add(entry.id);
        plugins.push(entry.create(reader));
      } else {
        plugins.push(entry);
      }
    }
    this.#engine = new Engine(this.#store, new PluginHost(plugins), this.#resolveConfig);
  }

  /**
   * Persists a new conversation record (its workspace + durable overrides) and returns it with its
   * freshly resolved config. Config is never stored — it is re-derived on every load.
   */
  async createConversation(options: CreateConversationOptions = {}): Promise<Conversation> {
    let overrides = options.overrides ?? {};
    if (options.parentId !== undefined) {
      const parent = this.#engine.configFor(options.parentId);
      if (!parent) throw new Error(`cannot create a child for inactive parent ${options.parentId}`);
      const plugins = Object.fromEntries(
        [...this.#inheritedPlugins].map((id) => [id, parent.plugins?.[id]]),
      );
      overrides = deepMerge({ model: parent.model, plugins }, overrides) as Record<string, unknown>;
    }
    const record = await this.#store.createConversation({
      workspaceRoot: options.cwd ?? null,
      overrides,
    });
    try {
      const conversation = await this.#resolve(record);
      // Persist the selection, not a second copy of resolved configuration. Other settings keep
      // their cascade; model defaults only select newly created conversations.
      await this.#store.updateConversationOverrides(record.id, {
        model: conversation.config.model,
      });
      conversation.overrides = { ...record.overrides, model: conversation.config.model };
      if (options.parentId !== undefined) {
        this.#engine.registerChild(options.parentId, record.id);
      }
      return conversation;
    } catch (e) {
      // Resolve can fail (bad project settings, unknown plugin in `overrides`); roll back so a failed
      // create leaves nothing. The record has no head/turns yet, so deleteConversationIfEmpty always reaps.
      await this.#store.deleteConversationIfEmpty(record.id);
      throw e;
    }
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
    await this.#pinLegacyModel(conversationId);
    return this.#engine.prepare(conversationId);
  }

  /**
   * Delivers user text with the given intent (`send`/`steer`/`queue`/`interrupt`).
   * Resolves once it is accepted, not once its turn completes. An empty-text
   * `interrupt` is a pure abort (no message seeds the next turn).
   */
  async deliver(
    conversationId: ConversationId,
    text: string,
    intent: DeliveryIntent,
  ): Promise<void> {
    await this.#pinLegacyModel(conversationId);
    return this.#engine.deliver(
      conversationId,
      { source: { kind: "user" }, content: text ? [{ type: "text", text }] : [] },
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

  /** Pre-selection records adopt the current default once, before entering an activation. */
  async #pinLegacyModel(conversationId: ConversationId): Promise<void> {
    // Turns and interrupts on loaded roots never wait behind another root's settings IO.
    if (this.#engine.configFor(conversationId) !== undefined) return;
    const existing = await this.#store.getConversation(conversationId);
    if (!existing) throw new Error(`unknown conversation: ${conversationId}`);
    if (existing.overrides.model !== undefined) return;
    return this.#serializeConfigMutation(async () => {
      const record = await this.#store.getConversation(conversationId);
      if (!record) throw new Error(`unknown conversation: ${conversationId}`);
      if (record.overrides.model !== undefined) return;
      const config = await this.#resolveConfig(record);
      await this.#store.updateConversationOverrides(conversationId, { model: config.model });
    });
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
  ): Promise<ConversationRecord[]> {
    return this.#store.listConversationPage(limit, before);
  }

  getItem(conversationId: ConversationId, itemId: ItemId): Promise<Item | undefined> {
    return this.#store.getItem(conversationId, itemId);
  }

  listItemAncestors(
    conversationId: ConversationId,
    start: ItemId | null,
    limit: number,
  ): Promise<Item[]> {
    return this.#store.listItemAncestors(conversationId, start, limit);
  }

  usageSummary(id: ConversationId): Promise<ModelUsageSummary> {
    return this.#store.summarizeModelUsage(id);
  }

  conversationTreeState(rootId: ConversationId) {
    return this.#engine.conversationTreeState(rootId);
  }

  rootConversationOf(conversationId: ConversationId): ConversationId {
    return this.#engine.rootConversationOf(conversationId);
  }

  /** Per-request usage/cost rows, in record order. Backs resume footer totals. */
  usage(id: ConversationId): Promise<ModelUsage[]> {
    return this.#store.listModelUsage(id);
  }

  /** Durable per-conversation plugin metadata — the `ConversationRunner` seam, forwarded to the store. */
  putPluginState(plugin: string, id: ConversationId, key: string, value: unknown): Promise<void> {
    return this.#store.putPluginState(plugin, id, key, value);
  }

  getPluginState(plugin: string, id: ConversationId, key: string): Promise<unknown> {
    return this.#store.getPluginState(plugin, id, key);
  }
}
