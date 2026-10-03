import {
  HARNESS_PROTOCOL_VERSION,
  MAX_ATTACH_BYTES,
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
  serverModelsRequest,
  wireItemSchema,
} from "@harness/protocol";
import type {
  AttachResult,
  HistoryEntry,
  InitializeResult,
  JsonValue,
  PeerInfo,
  PluginContract,
  WireConversation,
  WireConversationEvent,
  WireItem,
} from "@harness/protocol";
import { RpcPeer } from "./peer.ts";
import type { RpcConnection } from "./peer.ts";

export type HarnessClientEvent =
  | { type: "attached"; attachment: AttachResult }
  | { type: "detached"; rootConversationId: string; conversationIds: string[] }
  | {
      type: "conversation";
      rootConversationId: string;
      conversationId: string;
      event: WireConversationEvent;
    };

export interface HarnessClientOptions {
  readonly connection: RpcConnection;
  readonly client: PeerInfo;
  readonly plugins?: PluginContract[];
  readonly onProtocolError?: (error: Error) => void;
}

interface BufferedDelivery {
  rootConversationId: string;
  deliver(): void;
}

const encodedLength = (value: JsonValue): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Stateful client-side coordination; server authority remains behind semantic requests. */
export class HarnessClient {
  readonly peer: RpcPeer;
  readonly #info: PeerInfo;
  readonly #plugins: PluginContract[];
  readonly #listeners = new Set<(event: HarnessClientEvent) => void>();
  readonly #attachedRoots = new Set<string>();
  readonly #rootByConversation = new Map<string, string>();
  #pendingAttach: { targetRootId: string; events: BufferedDelivery[]; bytes: number } | undefined;
  #attachTail: Promise<void> = Promise.resolve();

  constructor(options: HarnessClientOptions) {
    this.#info = options.client;
    this.#plugins = options.plugins ?? [];
    this.peer = new RpcPeer({
      role: "client",
      connection: options.connection,
      ...(options.onProtocolError === undefined
        ? {}
        : { onProtocolError: options.onProtocolError }),
    });
    this.peer.onNotification(conversationEventNotification, (params) => {
      this.receive(params.rootConversationId, params, () => {
        this.#rootByConversation.set(params.conversationId, params.rootConversationId);
        this.#emit({ type: "conversation", ...params });
      });
    });
    this.peer.onNotification(conversationDetachedNotification, ({ rootConversationId }) => {
      const conversationIds = [...this.#rootByConversation]
        .filter(([, root]) => root === rootConversationId)
        .map(([id]) => id);
      this.#forgetRoot(rootConversationId);
      if (this.#pendingAttach?.targetRootId === rootConversationId) {
        this.#pendingAttach.events.length = 0;
        this.#pendingAttach.bytes = 0;
      }
      this.#emit({ type: "detached", rootConversationId, conversationIds });
    });
  }

  async start(): Promise<InitializeResult> {
    this.peer.listen();
    return this.peer.initialize({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      client: this.#info,
      plugins: this.#plugins,
    });
  }

  subscribe(listener: (event: HarnessClientEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Apply a core or plugin notification only after its root snapshot is accepted. */
  receive(rootConversationId: string, payload: JsonValue, deliver: () => void): void {
    const pending = this.#pendingAttach;
    if (
      pending !== undefined &&
      (rootConversationId === pending.targetRootId || !this.#attachedRoots.has(rootConversationId))
    ) {
      const bytes = encodedLength(payload);
      if (pending.bytes + bytes > MAX_ATTACH_BYTES) {
        pending.events.length = 0;
        pending.bytes = 0;
        this.peer.terminateProtocol("attachment event buffer exceeded its byte limit");
        return;
      }
      pending.events.push({ rootConversationId, deliver });
      pending.bytes += bytes;
      return;
    }
    if (this.#attachedRoots.has(rootConversationId)) {
      deliver();
      return;
    }
    this.peer.terminateProtocol(`event arrived for unattached root '${rootConversationId}'`);
  }

  models() {
    return this.peer.request(serverModelsRequest, {});
  }

  create(options: { cwd?: string; overrides?: Record<string, JsonValue> } = {}) {
    return this.peer.request(conversationCreateRequest, {
      cwd: options.cwd ?? null,
      overrides: options.overrides ?? {},
    });
  }

  get(conversationId: string) {
    return this.peer.request(conversationGetRequest, { conversationId });
  }

  list(options: { cursor?: { createdAt: number; id: string }; limit?: number } = {}) {
    return this.peer.request(conversationListRequest, {
      cursor: options.cursor ?? null,
      limit: options.limit ?? 50,
    });
  }

  attach(conversationId: string): Promise<AttachResult> {
    let resolveResult!: (result: AttachResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AttachResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = this.#attachTail.then(async () => {
      const pending = {
        targetRootId: this.#rootOf(conversationId),
        events: [] as BufferedDelivery[],
        bytes: 0,
      };
      this.#pendingAttach = pending;
      try {
        const attachment = await this.peer.request(conversationAttachRequest, { conversationId });
        this.#acceptAttachment(attachment);
        for (const event of pending.events) {
          if (event.rootConversationId !== attachment.root.id) {
            this.peer.terminateProtocol(
              `event for root '${event.rootConversationId}' crossed attachment '${attachment.root.id}'`,
            );
            throw new Error("event crossed an attachment boundary");
          }
          event.deliver();
        }
        resolveResult(attachment);
      } catch (error) {
        pending.events.length = 0;
        rejectResult(error);
      } finally {
        this.#pendingAttach = undefined;
      }
    });
    this.#attachTail = run.catch(() => undefined);
    return result;
  }

  async close(conversationId: string, force = false) {
    const result = await this.peer.request(conversationCloseRequest, {
      conversationId,
      force,
    });
    if (result.status === "closed") this.#forgetRoot(this.#rootOf(conversationId));
    return result;
  }

  reload(
    conversationId: string,
    force = false,
  ): Promise<{ status: "busy" } | { status: "reloaded"; attachment: AttachResult }> {
    let resolveResult!: (
      result: { status: "busy" } | { status: "reloaded"; attachment: AttachResult },
    ) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<
      { status: "busy" } | { status: "reloaded"; attachment: AttachResult }
    >((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = this.#attachTail.then(async () => {
      const root = this.#rootOf(conversationId);
      const pending = { targetRootId: root, events: [] as BufferedDelivery[], bytes: 0 };
      this.#pendingAttach = pending;
      try {
        const response = await this.peer.request(conversationReloadRequest, {
          conversationId,
          force,
        });
        if (response.status === "busy") {
          for (const event of pending.events) event.deliver();
        } else {
          this.#forgetRoot(root);
          this.#acceptAttachment(response.attachment);
          for (const event of pending.events) {
            if (event.rootConversationId !== response.attachment.root.id) {
              throw new Error("event crossed a reload boundary");
            }
            event.deliver();
          }
        }
        resolveResult(response);
      } catch (error) {
        if (this.#attachedRoots.has(root)) {
          for (const event of pending.events) event.deliver();
        }
        rejectResult(error);
      } finally {
        this.#pendingAttach = undefined;
      }
    });
    this.#attachTail = run.catch(() => undefined);
    return result;
  }

  deleteEmpty(conversationId: string) {
    return this.peer.request(conversationDeleteEmptyRequest, { conversationId });
  }

  deliver(conversationId: string, text: string, intent: "send" | "steer" | "queue" | "interrupt") {
    return this.peer.request(conversationDeliverRequest, { conversationId, text, intent });
  }

  rewind(conversationId: string, itemId: string) {
    return this.peer.request(conversationRewindRequest, { conversationId, itemId });
  }

  compact(conversationId: string) {
    return this.peer.request(conversationCompactRequest, { conversationId });
  }

  history(options: {
    conversationId: string;
    anchor?: string;
    cursor?: string;
    maxBytes?: number;
  }) {
    return this.peer.request(conversationHistoryRequest, {
      conversationId: options.conversationId,
      anchor: options.anchor ?? null,
      cursor: options.cursor ?? null,
      maxBytes: options.maxBytes ?? 512 * 1024,
    });
  }

  async readItem(conversationId: string, entry: Extract<HistoryEntry, { kind: "itemRef" }>) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await this.peer.request(conversationItemReadRequest, {
        conversationId,
        itemId: entry.itemId,
        offset,
        maxBytes: 512 * 1024,
      });
      chunks.push(Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0)));
      if (chunk.eof) break;
      if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
        throw new Error(`invalid item range for '${entry.itemId}'`);
      }
      offset = chunk.nextOffset;
    }
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (length !== entry.byteLength)
      throw new Error(`item '${entry.itemId}' changed while reading`);
    const bytes = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    return wireItemSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }

  usage(conversationId: string) {
    return this.peer.request(conversationUsageRequest, { conversationId });
  }

  setModel(conversationId: string, provider: string, model: string) {
    return this.peer.request(conversationModelSetRequest, {
      conversationId,
      provider,
      model,
    });
  }

  setPreset(
    conversationId: string,
    expected: { provider: string; model: string },
    preset?: string,
  ) {
    return this.peer.request(conversationPresetSetRequest, {
      conversationId,
      expected,
      preset: preset ?? null,
    });
  }

  patchPluginConfig(
    conversationId: string,
    pluginId: string,
    patch: Record<string, JsonValue>,
    saveGlobal = false,
  ) {
    return this.peer.request(conversationPluginConfigPatchRequest, {
      conversationId,
      pluginId,
      patch,
      saveGlobal,
    });
  }

  closeConnection(): void {
    this.peer.close();
  }

  #acceptAttachment(attachment: AttachResult): void {
    const root = attachment.root.id;
    this.#attachedRoots.add(root);
    this.#rootByConversation.set(root, root);
    for (const member of attachment.members) {
      this.#rootByConversation.set(member.conversation.id, root);
    }
    this.#emit({ type: "attached", attachment });
  }

  #forgetRoot(root: string): void {
    this.#attachedRoots.delete(root);
    for (const [conversationId, candidate] of this.#rootByConversation) {
      if (candidate === root) this.#rootByConversation.delete(conversationId);
    }
  }

  #rootOf(conversationId: string): string {
    return this.#rootByConversation.get(conversationId) ?? conversationId;
  }

  #emit(event: HarnessClientEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export const inlineHistoryItems = (entries: HistoryEntry[]): WireItem[] =>
  entries.flatMap((entry) => (entry.kind === "item" ? [entry.item] : []));

export const conversationFromAttachment = (attachment: AttachResult): WireConversation =>
  attachment.root;
