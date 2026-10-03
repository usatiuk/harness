import type {
  NotificationHandler,
  RequestHandler,
  RequestOptions,
  RpcConnection,
} from "@harness/client";
import {
  conversationAttachRequest,
  conversationCloseRequest,
  conversationCompactRequest,
  conversationCreateRequest,
  conversationDeleteEmptyRequest,
  conversationDeliverRequest,
  conversationDetachedNotification,
  conversationEventNotification,
  conversationGetRequest,
  conversationHistoryRequest,
  conversationItemReadRequest,
  conversationListRequest,
  conversationModelSetRequest,
  conversationPluginConfigPatchRequest,
  conversationPresetSetRequest,
  conversationReloadRequest,
  conversationRewindRequest,
  conversationUsageRequest,
  isKernelEvent,
  MAX_ATTACH_BYTES,
  serverModelsRequest,
} from "@harness/protocol";
import type {
  AttachResult,
  ConversationId,
  HistoryEntry,
  HarnessEvent,
  ItemId,
  JsonValue,
  ModelConfig,
  PeerInfo,
  PluginContract,
  RpcNotification,
  RpcRequest,
  WireConversationEvent,
} from "@harness/protocol";
import type { HarnessService } from "./service.ts";
import { RpcServer } from "./rpc-server.ts";
import {
  projectConversation,
  projectConversationConfig,
  projectItem,
  projectModelInfo,
  projectUsageSummary,
} from "./wire.ts";

const HISTORY_READ_BATCH = 200;

export interface HarnessRpcSessionOptions {
  readonly connection: RpcConnection;
  readonly service: HarnessService;
  readonly server: PeerInfo;
  readonly plugins?: PluginContract[];
  readonly onError?: (error: unknown) => void;
  readonly defaultModel?: ModelConfig;
}

/** One client connection, its attached root scopes, and the core semantic dispatch table. */
export class HarnessRpcSession {
  readonly server: RpcServer;
  readonly #service: HarnessService;
  readonly #owned = new Set<ConversationId>();
  readonly #attached = new Set<ConversationId>();
  readonly #unsubscribe: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #defaultModel: ModelConfig;
  readonly #snapshots = new Map<string, (rootId: ConversationId) => JsonValue>();
  readonly #eventObservers = new Set<(event: HarnessEvent, rootId: ConversationId) => void>();
  readonly #clientPlugins = new Map<string, number>();
  readonly #cleanups: Array<() => void> = [];
  readonly #closing = new Set<ConversationId>();
  readonly #attaching = new Set<ConversationId>();
  readonly #active = new Map<ConversationId, Set<AbortController>>();
  readonly #idleWaiters = new Map<ConversationId, Set<() => void>>();
  #shutdown: Promise<void> | undefined;

  constructor(options: HarnessRpcSessionOptions) {
    this.#service = options.service;
    this.#defaultModel = options.defaultModel ?? { provider: "demo", model: "demo-1" };
    this.#onError = options.onError ?? (() => undefined);
    options.connection.onClose(() => void this.shutdown(false));
    this.server = new RpcServer({
      connection: options.connection,
      server: options.server,
      ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
      onHandlerError: (error) => this.#onError(error),
      onProtocolError: (error) => this.#onError(error),
      onInitialize: (params) => {
        this.#clientPlugins.clear();
        for (const plugin of params.plugins) this.#clientPlugins.set(plugin.id, plugin.version);
      },
    });
    this.#registerCoreHandlers();
    this.#unsubscribe = this.#service.subscribe((event) => {
      const conversationId = this.#conversationIdOf(event);
      if (conversationId === undefined) return;
      const root = this.#service.rootConversationOf(conversationId);
      if (!this.#attached.has(root)) return;
      const projected = this.#projectEvent(event);
      if (projected !== undefined) {
        void this.server.peer
          .notify(conversationEventNotification, {
            rootConversationId: root,
            conversationId,
            event: projected,
          })
          .catch((error: unknown) => {
            this.#onError(error);
            this.server.peer.terminateProtocol("failed to send a conversation event");
          });
      }
      for (const observer of this.#eventObservers) observer(event, root);
    });
  }

  start(): void {
    this.server.start();
  }

  onRequest<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    handler: RequestHandler<P, R>,
  ): void {
    this.server.onRequest(definition, handler);
  }

  onNotification<P extends JsonValue>(
    definition: RpcNotification<P>,
    handler: NotificationHandler<P>,
  ): void {
    this.server.onNotification(definition, handler);
  }

  request<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    params: P,
    options?: RequestOptions,
  ): Promise<R> {
    return this.server.peer.request(definition, params, options);
  }

  notify<P extends JsonValue>(definition: RpcNotification<P>, params: P): Promise<void> {
    return this.server.peer.notify(definition, params);
  }

  registerSnapshot(pluginId: string, read: (rootId: ConversationId) => JsonValue): void {
    if (this.#snapshots.has(pluginId)) throw new Error(`duplicate plugin snapshot '${pluginId}'`);
    this.#snapshots.set(pluginId, read);
  }

  observeEvents(observer: (event: HarnessEvent, rootId: ConversationId) => void): () => void {
    this.#eventObservers.add(observer);
    const cleanup = () => this.#eventObservers.delete(observer);
    this.#cleanups.push(cleanup);
    return cleanup;
  }

  supportsClientPlugin(pluginId: string, version: number): boolean {
    return this.#clientPlugins.get(pluginId) === version;
  }

  isAttached(conversationId: ConversationId): boolean {
    const root = this.#service.rootConversationOf(conversationId);
    return this.#attached.has(root) && !this.#closing.has(root);
  }

  async runAttached<T>(
    conversationId: ConversationId,
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const root = this.#service.rootConversationOf(conversationId);
    if (!this.#attached.has(root) || this.#closing.has(root) || this.#shutdown !== undefined) {
      throw new Error(`conversation '${conversationId}' is not attached`);
    }
    return this.#runOwned(root, operation, requestSignal);
  }

  async #runOwned<T>(
    root: ConversationId,
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (requestSignal?.aborted) controller.abort();
    requestSignal?.addEventListener("abort", cancel, { once: true });
    let active = this.#active.get(root);
    if (active === undefined) {
      active = new Set();
      this.#active.set(root, active);
    }
    active.add(controller);
    try {
      if (controller.signal.aborted) throw new Error("operation cancelled");
      const result = await operation(controller.signal);
      if (controller.signal.aborted) throw new Error("operation cancelled");
      return result;
    } finally {
      requestSignal?.removeEventListener("abort", cancel);
      active.delete(controller);
      if (active.size === 0) {
        this.#active.delete(root);
        for (const resolve of this.#idleWaiters.get(root) ?? []) resolve();
        this.#idleWaiters.delete(root);
      }
    }
  }

  shutdown(closePeer = true): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#shutdown = this.#doShutdown(closePeer);
    return this.#shutdown;
  }

  async #doShutdown(closePeer: boolean): Promise<void> {
    this.#unsubscribe();
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    const roots = [...this.#owned];
    for (const root of roots) this.#closing.add(root);
    for (const root of roots) this.#cancelOperations(root);
    await Promise.all(roots.map((root) => this.#whenOperationsIdle(root)));
    const settled = await Promise.allSettled(
      roots.map((root) => this.#service.deactivateSession(root, { force: true })),
    );
    this.#owned.clear();
    this.#attached.clear();
    this.#closing.clear();
    for (const result of settled) {
      if (result.status === "rejected") this.#onError(result.reason);
    }
    if (closePeer) this.server.close();
  }

  #registerCoreHandlers(): void {
    this.server.onRequest(serverModelsRequest, () => ({
      models: this.#service.availableModels().map(projectModelInfo),
      defaultModel: {
        provider: this.#defaultModel.provider,
        model: this.#defaultModel.model,
        preset: this.#defaultModel.preset ?? null,
      },
    }));

    this.server.onRequest(conversationCreateRequest, async ({ cwd, overrides }) =>
      projectConversation(
        await this.#service.createConversation({
          ...(cwd === null ? {} : { cwd }),
          overrides,
        }),
      ),
    );

    this.server.onRequest(conversationGetRequest, async ({ conversationId }) => {
      const conversation = await this.#service.getConversation(conversationId as ConversationId);
      return conversation === undefined ? null : projectConversation(conversation);
    });

    this.server.onRequest(conversationListRequest, async ({ cursor, limit }) => {
      const records = await this.#service.listConversationPage(
        limit,
        cursor === null
          ? undefined
          : { createdAt: cursor.createdAt, id: cursor.id as ConversationId },
      );
      const conversations = [];
      for (const record of records) {
        const conversation = await this.#service.getConversation(record.id);
        if (conversation !== undefined) conversations.push(projectConversation(conversation));
      }
      const last = records.at(-1);
      return {
        conversations,
        nextCursor:
          records.length < limit || last === undefined
            ? null
            : { createdAt: last.createdAt, id: last.id },
      };
    });

    this.server.onRequest(conversationAttachRequest, ({ conversationId }, signal) =>
      this.#attach(conversationId as ConversationId, signal),
    );

    this.server.onRequest(conversationCloseRequest, async ({ conversationId, force }) => {
      const id = conversationId as ConversationId;
      const result = await this.#deactivate(id, force);
      return { status: result.status === "deactivated" ? "closed" : "busy" };
    });

    this.server.onRequest(conversationReloadRequest, async ({ conversationId, force }) => {
      const id = conversationId as ConversationId;
      const root = this.#service.rootConversationOf(id);
      const result = await this.#deactivate(root, force);
      if (result.status === "busy") return { status: "busy" as const };
      return { status: "reloaded" as const, attachment: await this.#attach(root) };
    });

    this.server.onRequest(conversationDeleteEmptyRequest, async ({ conversationId }) => {
      const id = conversationId as ConversationId;
      return this.runAttached(id, async () => {
        await this.#service.deleteConversationIfEmpty(id);
        return null;
      });
    });

    this.server.onRequest(conversationDeliverRequest, async ({ conversationId, text, intent }) => {
      const id = conversationId as ConversationId;
      return this.runAttached(id, async () => {
        await this.#service.deliver(id, text, intent);
        return null;
      });
    });

    this.server.onRequest(conversationRewindRequest, async ({ conversationId, itemId }) => {
      const id = conversationId as ConversationId;
      return this.runAttached(id, async () => {
        await this.#service.rewind(id, itemId as ItemId);
        return null;
      });
    });

    this.server.onRequest(conversationCompactRequest, async ({ conversationId }, signal) => {
      const id = conversationId as ConversationId;
      return this.runAttached(
        id,
        async (operationSignal) => ({
          status: await this.#service.compact(id, operationSignal),
        }),
        signal,
      );
    });

    this.server.onRequest(conversationHistoryRequest, (params) =>
      this.runAttached(params.conversationId as ConversationId, () => this.#history(params)),
    );
    this.server.onRequest(conversationItemReadRequest, (params) =>
      this.runAttached(params.conversationId as ConversationId, () => this.#readItem(params)),
    );

    this.server.onRequest(conversationUsageRequest, async ({ conversationId }) => {
      const id = conversationId as ConversationId;
      return this.runAttached(id, async () =>
        projectUsageSummary(await this.#service.usageSummary(id)),
      );
    });

    this.server.onRequest(
      conversationModelSetRequest,
      async ({ conversationId, provider, model }) => {
        const id = conversationId as ConversationId;
        return this.runAttached(id, async () => {
          await this.#service.setModel(id, { provider, model });
          return null;
        });
      },
    );

    this.server.onRequest(
      conversationPresetSetRequest,
      async ({ conversationId, expected, preset }) => {
        const id = conversationId as ConversationId;
        return this.runAttached(id, async () => {
          await this.#service.setPreset(id, expected, preset ?? undefined);
          return null;
        });
      },
    );

    this.server.onRequest(
      conversationPluginConfigPatchRequest,
      async ({ conversationId, pluginId, patch, saveGlobal }) => {
        const id = conversationId as ConversationId;
        return this.runAttached(id, async () => {
          await this.#service.setPluginConfig(id, pluginId, patch, { saveGlobal });
          return null;
        });
      },
    );
  }

  async #deactivate(rootOrMember: ConversationId, force: boolean) {
    const root = this.#service.rootConversationOf(rootOrMember);
    if (!this.#attached.has(root) || this.#closing.has(root)) {
      throw new Error(`conversation '${rootOrMember}' is not attached`);
    }
    this.#closing.add(root);
    try {
      if (force) this.#cancelOperations(root);
      await this.#whenOperationsIdle(root);
      const result = await this.#service.deactivateSession(root, { force });
      return result;
    } finally {
      // Engine completes all disposal before reporting cleanup errors. Membership follows the
      // surviving activation, not whether the request happened to return successfully.
      if (this.#service.conversationTreeState(root).length === 0) {
        this.#attached.delete(root);
        this.#owned.delete(root);
        void this.server.peer
          .notify(conversationDetachedNotification, { rootConversationId: root })
          .catch((error: unknown) => {
            this.#onError(error);
            this.server.peer.terminateProtocol("failed to send conversation detachment");
          });
      }
      this.#closing.delete(root);
    }
  }

  async #attach(
    conversationId: ConversationId,
    requestSignal?: AbortSignal,
  ): Promise<AttachResult> {
    const rootId = this.#service.rootConversationOf(conversationId);
    if (this.#shutdown !== undefined || this.#closing.has(rootId)) {
      throw new Error("connection is shutting down");
    }
    if (this.#attaching.has(rootId))
      throw new Error(`conversation '${rootId}' is already attaching`);
    const newlyOwned = !this.#owned.has(rootId);
    this.#owned.add(rootId);
    this.#attaching.add(rootId);
    try {
      const result = await this.#runOwned(
        rootId,
        (signal) => this.#buildAttachment(conversationId, rootId, signal),
        requestSignal,
      );
      if (this.#shutdown !== undefined || this.#closing.has(rootId)) {
        throw new Error("connection closed during attachment");
      }
      this.#attached.add(rootId);
      return result;
    } catch (error) {
      if (newlyOwned && this.#shutdown === undefined) {
        this.#closing.add(rootId);
        this.#cancelOperations(rootId);
        try {
          await this.#whenOperationsIdle(rootId);
          await this.#service.deactivateSession(rootId, { force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "attachment and cleanup failed", {
            cause: cleanupError,
          });
        } finally {
          this.#owned.delete(rootId);
          this.#closing.delete(rootId);
        }
      }
      throw error;
    } finally {
      this.#attaching.delete(rootId);
    }
  }

  async #buildAttachment(
    conversationId: ConversationId,
    rootId: ConversationId,
    signal: AbortSignal,
  ): Promise<AttachResult> {
    await this.#service.prepare(conversationId);
    if (signal.aborted || this.#shutdown !== undefined || this.#closing.has(rootId)) {
      throw new Error("attachment cancelled");
    }
    if (this.#service.rootConversationOf(conversationId) !== rootId) {
      throw new Error("conversation tree changed during attachment");
    }
    const [root, usage] = await Promise.all([
      this.#service.getConversation(rootId),
      this.#service.usageSummary(rootId),
    ]);
    if (signal.aborted || this.#shutdown !== undefined || this.#closing.has(rootId)) {
      throw new Error("attachment cancelled");
    }
    if (root === undefined) throw new Error(`unknown conversation: ${rootId}`);

    // No await from the authoritative snapshot through admission to the live set.
    const members = this.#service.conversationTreeState(rootId);
    const liveRoot = members.find((member) => member.conversation.id === rootId);
    if (!liveRoot) throw new Error("attachment omitted its root runtime");
    const result: AttachResult = {
      root: projectConversation({ ...root, config: liveRoot.conversation.config }),
      members: members.map((member) => ({
        conversation: projectConversation(member.conversation),
        live: {
          conversationId: member.conversation.id,
          status: member.status,
          turnId: member.turnId,
          pendingInput: member.pendingInput,
        },
      })),
      usage: projectUsageSummary(usage),
      plugins: Object.fromEntries(
        [...this.#snapshots].map(([pluginId, read]) => [pluginId, read(rootId)]),
      ),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ATTACH_BYTES) {
      this.server.peer.terminateProtocol("attachment snapshot exceeds its byte limit");
      void this.shutdown(false);
      throw new Error("attachment snapshot exceeds its byte limit");
    }
    return result;
  }

  #cancelOperations(root: ConversationId): void {
    this.#service.cancelSession(root);
    for (const controller of this.#active.get(root) ?? []) controller.abort();
  }

  async #whenOperationsIdle(root: ConversationId): Promise<void> {
    if ((this.#active.get(root)?.size ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      let waiters = this.#idleWaiters.get(root);
      if (waiters === undefined) {
        waiters = new Set();
        this.#idleWaiters.set(root, waiters);
      }
      waiters.add(resolve);
    });
  }

  async #history(params: {
    conversationId: string;
    anchor: string | null;
    cursor: string | null;
    maxBytes: number;
  }) {
    const conversationId = params.conversationId as ConversationId;
    const conversation = await this.#service.getConversation(conversationId);
    if (conversation === undefined) throw new Error(`unknown conversation: ${conversationId}`);
    const anchor = (params.anchor ?? conversation.head) as ItemId | null;
    const start = (params.cursor ?? anchor) as ItemId | null;
    const items = await this.#service.listItemAncestors(conversationId, start, HISTORY_READ_BATCH);
    const entries: HistoryEntry[] = [];
    let used = 0;
    let nextCursor: ItemId | null = null;
    for (const item of items) {
      const projected = projectItem(item);
      const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
      const inline: HistoryEntry = { kind: "item", item: projected };
      const inlineBytes = Buffer.byteLength(JSON.stringify(inline), "utf8");
      const entry: HistoryEntry =
        used + inlineBytes <= params.maxBytes
          ? inline
          : { kind: "itemRef", itemId: item.id, byteLength: bytes };
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (entries.length > 0 && used + entryBytes > params.maxBytes) {
        nextCursor = item.id;
        break;
      }
      entries.push(entry);
      used += entryBytes;
      nextCursor = item.parent;
    }
    return { anchor, entries, nextCursor };
  }

  async #readItem(params: {
    conversationId: string;
    itemId: string;
    offset: number;
    maxBytes: number;
  }) {
    const item = await this.#service.getItem(
      params.conversationId as ConversationId,
      params.itemId as ItemId,
    );
    if (item === undefined) throw new Error(`unknown item: ${params.itemId}`);
    const bytes = Buffer.from(JSON.stringify(projectItem(item)), "utf8");
    const end = Math.min(bytes.byteLength, params.offset + params.maxBytes);
    const eof = end >= bytes.byteLength;
    return {
      encoding: "base64" as const,
      offset: params.offset,
      data: bytes.subarray(params.offset, end).toString("base64"),
      nextOffset: eof ? null : end,
      eof,
    };
  }

  #conversationIdOf(event: HarnessEvent): ConversationId | undefined {
    const conversationId = (event as { conversationId?: unknown }).conversationId;
    return typeof conversationId === "string" ? (conversationId as ConversationId) : undefined;
  }

  #projectEvent(event: HarnessEvent): WireConversationEvent | undefined {
    if (!isKernelEvent(event)) return undefined;
    switch (event.type) {
      case "item.appended":
        return { type: "item.appended", item: projectItem(event.item) };
      case "turn.status":
        return {
          type: "turn.changed",
          turnId: event.turnId,
          status: event.status,
          error: event.error ?? null,
        };
      case "inbox":
        return {
          type: "input.changed",
          pending: event.pending.filter(
            (input): input is { intent: "queue" | "steer"; text: string } =>
              input.intent === "queue" || input.intent === "steer",
          ),
        };
      case "text_delta":
        return { type: "text.delta", turnId: event.turnId, text: event.text };
      case "reasoning_delta":
        return { type: "reasoning.delta", turnId: event.turnId, text: event.text };
      case "head.changed":
        return { type: "head.changed", head: event.head };
      case "config.changed":
        return { type: "config.changed", config: projectConversationConfig(event.config) };
      case "usage.changed":
        return {
          type: "usage.changed",
          summary: projectUsageSummary(event.summary),
        };
      case "request.created":
      case "request.resolved":
        return undefined;
    }
  }
}
