import type {
  Conversation,
  ConversationId,
  DeliveryIntent,
  HarnessEvent,
  Item,
  ItemId,
  ModelConfig,
  ModelInfo,
  Plugin,
  PluginEntry,
  Store,
} from "@harness/protocol";
import { isPluginDefinition } from "@harness/protocol";
import { Engine, PluginHost } from "@harness/core";
import {
  defaultHome,
  resolveSettings,
  StoreConfigReader,
  updateGlobalModel,
  type SettingsDoc,
} from "@harness/config";
import type { ZodType } from "zod";

export interface HarnessServiceOptions {
  store: Store;
  /** Plain plugins, plus config-owning `PluginDefinition`s (validated centrally). */
  plugins: PluginEntry[];
  /** Harness home directory (global settings; later the db root). Defaults to `~/.harness`. */
  home?: string;
}

export interface CreateConversationOptions {
  /** Project search root; absent ⇒ projectless (no project settings, no workspace). */
  cwd?: string;
  /** Named profile to overlay above project settings. */
  profile?: string;
  /** Programmatic top layer (highest precedence), e.g. a CLI-chosen model. */
  overrides?: SettingsDoc;
}

export type EventListener = (event: HarnessEvent) => void;

/**
 * The single façade every client calls: typed events out, one delivery seam in.
 * Holds no control state — that lives in the loop and the log. Owns config
 * resolution: it builds the plugin schema registry and resolves the settings
 * cascade into each conversation's frozen snapshot at creation.
 */
export class HarnessService {
  readonly #store: Store;
  readonly #engine: Engine;
  readonly #home: string;
  readonly #schemas = new Map<string, ZodType>();

  constructor(options: HarnessServiceOptions) {
    this.#store = options.store;
    this.#home = options.home ?? defaultHome();
    const reader = new StoreConfigReader(this.#store);
    const plugins: Plugin[] = [];
    for (const entry of options.plugins) {
      if (isPluginDefinition(entry)) {
        this.#schemas.set(entry.id, entry.configSchema);
        plugins.push(entry.create(reader));
      } else {
        plugins.push(entry);
      }
    }
    this.#engine = new Engine(this.#store, new PluginHost(plugins));
  }

  /** Resolves the settings cascade and stores the frozen snapshot on the new conversation. */
  async createConversation(options: CreateConversationOptions = {}): Promise<Conversation> {
    const config = await resolveSettings({
      home: this.#home,
      schemas: this.#schemas,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
    });
    return this.#store.createConversation({ config });
  }

  /**
   * Delivers user text with the given intent (`send`/`steer`/`queue`/`interrupt`).
   * Resolves once it is accepted, not once its turn completes. An empty-text
   * `interrupt` is a pure abort (no message seeds the next turn).
   */
  deliver(conversationId: ConversationId, text: string, intent: DeliveryIntent): Promise<void> {
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

  /** Resolves when the conversation has no running or queued work. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#engine.whenIdle(conversationId);
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
  async setModel(conversationId: ConversationId, model: ModelConfig): Promise<void> {
    await this.#engine.setModel(conversationId, model);
    await updateGlobalModel(this.#home, model);
  }

  /** Subscribes to the typed event stream. Returns an unsubscribe handle. */
  subscribe(listener: EventListener): () => void {
    return this.#engine.subscribe({ onEvent: listener });
  }

  /** One conversation by id. Backs session resume. */
  getConversation(id: ConversationId): Promise<Conversation | undefined> {
    return this.#store.getConversation(id);
  }

  /** All conversations, most-recent-first. Backs the resume picker. */
  listConversations(): Promise<Conversation[]> {
    return this.#store.listConversations();
  }

  /** The active item chain (head's ancestry) — the render/resume source for a conversation. */
  getItems(id: ConversationId): Promise<Item[]> {
    return this.#store.listActiveItems(id);
  }
}
