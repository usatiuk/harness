import type { ConversationId, JsonValue, RpcNotification } from "@harness/protocol";
import type { HarnessService } from "./service.ts";

/** Shared lifetime authority for RPC work; a client session owns only observation. */
export class HarnessRpcHost {
  readonly service: HarnessService;
  readonly #roots = new Set<ConversationId>();
  readonly #closing = new Set<ConversationId>();
  readonly #active = new Map<ConversationId, Set<AbortController>>();
  readonly #idleWaiters = new Map<ConversationId, Set<() => void>>();
  readonly #detached = new Set<(root: ConversationId) => void>();
  readonly #requests = new Set<Promise<unknown>>();
  readonly #notifications = new Set<
    (root: ConversationId, definition: RpcNotification<JsonValue>, params: JsonValue) => void
  >();
  #stopping = false;
  #shutdown: Promise<void> | undefined;

  constructor(service: HarnessService) {
    this.service = service;
  }

  isClosing(root: ConversationId): boolean {
    return this.#stopping || this.#closing.has(root);
  }

  request<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#stopping) return Promise.reject(new Error("server is stopping"));
    const request = Promise.resolve().then(operation);
    this.#requests.add(request);
    void request.finally(() => this.#requests.delete(request)).catch(() => undefined);
    return request;
  }

  onDetached(listener: (root: ConversationId) => void): () => void {
    this.#detached.add(listener);
    return () => this.#detached.delete(listener);
  }

  subscribeNotifications(
    listener: (
      root: ConversationId,
      definition: RpcNotification<JsonValue>,
      params: JsonValue,
    ) => void,
  ): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  broadcast<P extends JsonValue>(
    root: ConversationId,
    definition: RpcNotification<P>,
    params: P,
  ): void {
    for (const listener of this.#notifications) listener(root, definition, params);
  }

  async run<T>(
    root: ConversationId,
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    if (this.isClosing(root)) throw new Error("conversation is closing");
    this.#roots.add(root);
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
        if (this.service.conversationTreeState(root).length === 0) this.#roots.delete(root);
        for (const resolve of this.#idleWaiters.get(root) ?? []) resolve();
        this.#idleWaiters.delete(root);
      }
    }
  }

  async deactivate(root: ConversationId, force: boolean) {
    if (this.isClosing(root)) throw new Error("conversation is closing");
    this.#closing.add(root);
    try {
      if (force) this.#cancel(root);
      await this.#whenIdle(root);
      return await this.service.deactivateSession(root, { force });
    } finally {
      if (this.service.conversationTreeState(root).length === 0) {
        this.#roots.delete(root);
        for (const listener of this.#detached) listener(root);
      }
      this.#closing.delete(root);
    }
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#doShutdown();
    return this.#shutdown;
  }

  /** Claim idle shutdown synchronously, closing admission before the stop response. */
  beginShutdownIfIdle(): boolean {
    if (this.#requests.size !== 0 || this.#active.size !== 0) return false;
    for (const root of this.#roots) {
      if (this.service.isSessionBusy(root)) return false;
    }
    this.#stopping = true;
    return true;
  }

  async #doShutdown(): Promise<void> {
    this.#stopping = true;
    const roots = [...this.#roots];
    for (const root of roots) this.#cancel(root);
    await Promise.allSettled([...this.#requests]);
    await Promise.all(roots.map((root) => this.#whenIdle(root)));
    const results = await Promise.allSettled(
      roots.map((root) => this.service.deactivateSession(root, { force: true })),
    );
    this.#roots.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Conversation shutdown failed");
  }

  #cancel(root: ConversationId): void {
    this.service.cancelSession(root);
    for (const controller of this.#active.get(root) ?? []) controller.abort();
  }

  async #whenIdle(root: ConversationId): Promise<void> {
    if (!this.#active.has(root)) return;
    await new Promise<void>((resolve) => {
      let waiters = this.#idleWaiters.get(root);
      if (waiters === undefined) {
        waiters = new Set();
        this.#idleWaiters.set(root, waiters);
      }
      waiters.add(resolve);
    });
  }
}
