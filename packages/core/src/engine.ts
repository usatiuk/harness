import {
  assertNever,
  conversationOf,
  costOf,
  errorResult,
  findModel,
  textOf,
  type ConfigResolver,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type ContentBlock,
  type ContextBuild,
  type DeliveryInput,
  type DeliveryIntent,
  type HarnessEvent,
  type ItemId,
  type KernelEvent,
  type ModelConfig,
  type ModelInfo,
  type ModelPricing,
  type ModelRequest,
  type ModelStreamEvent,
  type NewContextBuild,
  type Observer,
  type PluginEvent,
  type ProviderPayloadDraft,
  type Store,
  type ToolCall,
  type ToolHandler,
  type ToolMiddlewareContext,
  type ToolResult,
  type ToolSchema,
  type TurnId,
} from "@harness/protocol";
import type { PluginHost } from "./plugin-host.ts";
import type { ToolSet } from "./registry.ts";
import { parseToolArgs } from "./tools.ts";
import { compactedWindow } from "./policies.ts";
import { Runtime, type Delivery } from "./runtime.ts";
import { applyDelivery } from "./delivery.ts";
import { runModelChain, runToolChain } from "./compose.ts";
import { reconcileConversation } from "./reconcile.ts";

const MAX_MODEL_STEPS = 100;

/** Result for a call abandoned or never started because the turn was aborted. */
const interruptedResult = (): ToolResult => errorResult("interrupted: turn aborted by new input");

/** Internal sentinel distinguishing an aborted turn from a failed one. Never escapes. */
class TurnAborted extends Error {
  constructor() {
    super("turn aborted");
    this.name = "TurnAborted";
  }
}

/**
 * The control loop: one Engine per process drives many per-conversation Runtimes.
 * It branches only on model/tool outcomes, never on delivery intent (that mapping
 * lives in `delivery.ts`). A throwing turn fails only that turn — the drain loop
 * continues, so one conversation never crashes the process.
 */
export class Engine {
  /** Each observer with its optional conversation scope; unscoped ones see every event. */
  readonly #observers: { observer: Observer; scope?: ConversationId }[];
  readonly #runtimes = new Map<ConversationId, Runtime>();
  readonly #loading = new Map<ConversationId, Promise<Runtime>>();
  /** Monotonic source for ephemeral request ids (process-local; not durable). */
  #requestSeq = 0;

  constructor(
    private readonly store: Store,
    private readonly host: PluginHost,
    /** Derives a conversation's config from its record on every load — injected so core stays free
     *  of `@harness/config`. */
    private readonly resolveConfig: ConfigResolver,
  ) {
    this.#observers = host.observers.map((observer) => ({ observer }));
  }

  /**
   * Read-only event subscription. With a `conversationId`, the observer receives only
   * that conversation's events (events carrying no conversation are not delivered to a
   * scoped observer); without one, it receives every event. Returns an unsubscribe handle.
   */
  subscribe(observer: Observer, conversationId?: ConversationId): () => void {
    const entry = conversationId === undefined ? { observer } : { observer, scope: conversationId };
    this.#observers.push(entry);
    return () => {
      const i = this.#observers.indexOf(entry);
      if (i >= 0) this.#observers.splice(i, 1);
    };
  }

  /**
   * The single seam through which all input that wakes the agent flows. Returns
   * once the input is *accepted*, not once its turn completes — that is what lets
   * input arrive while a turn runs. Completion is observed on the event stream
   * (`turn.status`); `whenIdle` awaits whole-conversation quiescence.
   */
  async deliver(
    conversationId: ConversationId,
    input: DeliveryInput,
    intent: DeliveryIntent = "send",
  ): Promise<void> {
    const runtime = await this.#runtime(conversationId);
    applyDelivery(runtime, { input, intent });
    this.#emitInbox(runtime);
    this.#ensureRunning(runtime);
  }

  /**
   * Warms a conversation before its first turn: loads the runtime and resolves its execution
   * backend, binding the plugin-emit channel so a lazily-provisioned substrate (docker) can stream
   * build progress and the TUI's pre-turn `!cmd`/`/sandbox` reach a live backend. Idempotent —
   * `#runtime`/`#service` are cached and `bind` is cheap. Unlike `deliver`, it starts no turn.
   */
  async prepare(conversationId: ConversationId): Promise<void> {
    const runtime = await this.#runtime(conversationId);
    const execution = this.#service(runtime, "execution") as
      | { bind?: (emit: (event: PluginEvent) => void) => void }
      | undefined;
    execution?.bind?.((event) => this.#emitPlugin({ conversationId, ...event }));
  }

  /**
   * Answers a pending `ctx.request` raised by a middleware. Point-to-point and
   * correlated by id — deliberately not routed through the inbox/delivery intents.
   * A no-op if the request is unknown (already resolved, or cancelled by abort).
   */
  respond(conversationId: ConversationId, requestId: string, response: unknown): void {
    this.#runtimes.get(conversationId)?.pendingRequests.get(requestId)?.resolve(response);
  }

  /**
   * Linear rewind: move the conversation's `head` to an earlier item. The next
   * `deliver` builds from there; continuing past a rewind branches (the abandoned
   * tail stays in the raw log). Refuses while a turn is running.
   */
  async rewind(conversationId: ConversationId, toItemId: ItemId): Promise<void> {
    const runtime = await this.#runtime(conversationId);
    if (runtime.running) {
      throw new Error(`cannot rewind conversation ${conversationId} while a turn is running`);
    }
    await this.store.setHead(conversationId, toItemId);
  }

  /** Resolves when the conversation's loop is idle and its inbox is drained. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#runtimes.get(conversationId)?.whenIdle() ?? Promise.resolve();
  }

  /**
   * Resolve a per-conversation plugin service for a client read (e.g. the TUI reading the
   * activity manager) — the same instance tools see via `ctx.service`. `undefined` when the
   * conversation has no live runtime yet or no plugin owns `key`; never loads a runtime.
   */
  serviceFor(conversationId: ConversationId, key: string): unknown {
    const runtime = this.#runtimes.get(conversationId);
    return runtime ? this.#service(runtime, key) : undefined;
  }

  /** Resolve-and-cache a service for a runtime, building it from its provider on first use. */
  #service(runtime: Runtime, key: string): unknown {
    if (runtime.services.has(key)) return runtime.services.get(key);
    const built = this.host.services.get(key)?.for(runtime.conversation);
    runtime.services.set(key, built);
    return built;
  }

  /** Aggregate model catalog across registered providers. */
  availableModels(): ModelInfo[] {
    return this.host.providers.listModels();
  }

  /**
   * Persists the model into the conversation's durable `overrides` (so it survives resume),
   * re-resolves its config, and swaps it onto the live runtime for the next turn. Emits the
   * *resolved* model (which may differ from the requested one — e.g. a settings-level `effort` rides
   * along), keeping clients in sync with what the next turn will actually use.
   */
  async setModel(conversationId: ConversationId, model: ModelConfig): Promise<void> {
    await this.store.updateConversationOverrides(conversationId, { model });
    const record = await this.store.getConversation(conversationId);
    if (!record) throw new Error(`unknown conversation: ${conversationId}`);
    const config = await this.resolveConfig(record);
    this.#runtimes.get(conversationId)?.setConversation({ ...record, config });
    this.#emitKernel({ type: "config.changed", conversationId, model: config.model });
  }

  /**
   * The resolved config of a live runtime, or `undefined` when none is loaded. Backs the config
   * reader's hot path (a tool call always runs inside a loaded runtime); never loads a runtime.
   */
  configFor(conversationId: ConversationId): ConversationConfig | undefined {
    return this.#runtimes.get(conversationId)?.conversation.config;
  }

  /** Loads (and caches) the runtime, guarding against concurrent first-touch. */
  #runtime(conversationId: ConversationId): Promise<Runtime> {
    const existing = this.#runtimes.get(conversationId);
    if (existing) return Promise.resolve(existing);
    let loading = this.#loading.get(conversationId);
    if (!loading) {
      loading = this.#loadRuntime(conversationId);
      this.#loading.set(conversationId, loading);
    }
    return loading;
  }

  async #loadRuntime(conversationId: ConversationId): Promise<Runtime> {
    try {
      const record = await this.store.getConversation(conversationId);
      if (!record) {
        throw new Error(`unknown conversation: ${conversationId}`);
      }
      // Repair crash residue before a turn can start: a stale `running` turn would
      // wedge `createTurn`. Single-flighted by `#loading`, so it runs once.
      await reconcileConversation(this.store, conversationId);
      // Resolve config from the cascade + overrides HERE, on every load — not frozen at creation —
      // so settings edits and the durable overrides both reach a resumed conversation.
      const config = await this.resolveConfig(record);
      const runtime = new Runtime({ ...record, config });
      this.#runtimes.set(conversationId, runtime);
      return runtime;
    } finally {
      this.#loading.delete(conversationId);
    }
  }

  /** Starts the detached drain loop if it isn't already running. */
  #ensureRunning(runtime: Runtime): void {
    if (runtime.running) return;
    runtime.running = true;
    void this.#drain(runtime);
  }

  /**
   * Takes the *whole* inbox each iteration and runs it as one batched turn;
   * whatever arrives mid-turn is picked up on the next iteration. The final
   * empty-check and `running = false` are synchronous and adjacent (no await
   * between them), so a concurrent `deliver` either appended before the check
   * (drained here) or restarts the loop afterwards — never lost.
   */
  async #drain(runtime: Runtime): Promise<void> {
    while (runtime.inbox.length > 0) {
      const batch = runtime.inbox.splice(0);
      this.#emitInbox(runtime);
      await this.#runTurn(runtime, batch);
    }
    runtime.running = false;
    runtime.signalIdle();
  }

  /** Runs one turn seeded by a batch: each entry's content is a user message. */
  async #runTurn(runtime: Runtime, batch: Delivery[]): Promise<void> {
    // Snapshot the resolved conversation for the whole turn. `setModel` replaces
    // `runtime.conversation` wholesale (never mutates it in place), so a switch between turns is
    // picked up here on the next turn, while one mid-turn leaves this captured reference — and thus
    // the model used for every request and recorded as its usage — unchanged.
    const conversation = runtime.conversation;
    const controller = new AbortController();
    runtime.controller = controller;

    const turn = await this.store.createTurn(conversation.id);
    runtime.currentTurnId = turn.id;
    this.#emitKernel({
      type: "turn.status",
      conversationId: conversation.id,
      turnId: turn.id,
      status: "running",
    });

    for (const delivery of batch) {
      const message = await this.store.appendItem({
        conversationId: conversation.id,
        turnId: turn.id,
        type: "message",
        role: "user",
        content: delivery.input.content,
      });
      this.#emitKernel({ type: "message", conversationId: conversation.id, item: message });
    }

    try {
      await this.#runSteps(conversation, turn.id, controller.signal, runtime);
      await this.store.updateTurn(turn.id, "completed");
      this.#emitKernel({
        type: "turn.status",
        conversationId: conversation.id,
        turnId: turn.id,
        status: "completed",
      });
    } catch (error) {
      if (error instanceof TurnAborted) {
        await this.store.updateTurn(turn.id, "aborted");
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: "aborted",
        });
      } else {
        await this.store.updateTurn(turn.id, "failed");
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: "failed",
          error: String(error),
        });
      }
    } finally {
      runtime.currentTurnId = undefined;
      runtime.controller = undefined;
    }
  }

  /**
   * The tool-shaped step loop, two phases per step:
   * 1. Consume the stream, writing assistant items in emission order — text is
   *    flushed as a message at each `tool_call` (and at `completed`), so interleaved
   *    text/calls store and replay in order.
   * 2. Dispatch, pairing every recorded call with a `tool_result` (synthetic
   *    `interrupted` when aborted). Invariant: every call is paired before the only
   *    `throw`, so a call never dangles.
   */
  async #runSteps(
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<void> {
    await this.#maybeCompact(conversation, turnId, signal);
    // Model config is fixed for the whole turn, so the provider, tool set, and tool schemas
    // are resolved once here rather than per step.
    const provider = this.host.providers.get(conversation.config.model.provider);
    const toolSet = this.host.toolsFor(
      provider.capabilities(conversation.config.model.model),
      {
        service: (key) => this.#service(runtime, key),
      },
      conversation.config.tools?.allow,
    );
    const toolSchemas = toolSet.schemas();
    const pricing = this.#pricingFor(conversation.config.model);
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      const build = await this.#buildContext(conversation, toolSchemas);
      const request: ModelRequest = {
        instructions: build.instructions,
        items: build.items,
        tools: build.tools,
        modelConfig: conversation.config.model,
      };

      const calls: ToolCall[] = [];
      let completed: Extract<ModelStreamEvent, { type: "completed" }> | undefined;
      let pendingText = "";
      // The step's final assistant message — the item `completed.payload` binds to.
      let lastMessageId: ItemId | undefined;

      const bindPayload = async (itemId: ItemId, draft?: ProviderPayloadDraft): Promise<void> => {
        if (draft) await this.store.putProviderPayload({ ...draft, itemId });
      };

      const flushText = async (): Promise<void> => {
        if (pendingText.length === 0) return;
        const message = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: pendingText }],
        });
        lastMessageId = message.id;
        this.#emitKernel({ type: "message", conversationId: conversation.id, item: message });
        pendingText = "";
      };

      // --- Consume phase: assistant content, in emission order. ---
      const stream = runModelChain(
        this.host.modelMiddleware,
        request,
        { conversationId: conversation.id, signal, toolMeta: (name) => toolSet.metaOf(name) },
        (req) => provider.stream(req, signal),
      );
      for await (const event of stream) {
        if (signal.aborted) break;
        switch (event.type) {
          case "text_delta":
            pendingText += event.text;
            this.#emitKernel({
              type: "text_delta",
              conversationId: conversation.id,
              turnId,
              text: event.text,
            });
            break;
          case "reasoning_delta":
            this.#emitKernel({
              type: "reasoning_delta",
              conversationId: conversation.id,
              turnId,
              text: event.text,
            });
            break;
          case "reasoning": {
            await flushText(); // preserve emission order against any preceding text
            const item = await this.store.appendItem({
              conversationId: conversation.id,
              turnId,
              type: "reasoning",
              content: event.content,
            });
            await bindPayload(item.id, event.payload);
            this.#emitKernel({ type: "reasoning", conversationId: conversation.id, item });
            break;
          }
          case "tool_call": {
            await flushText(); // any text before this call is its own message item
            const callItem = await this.store.appendItem({
              conversationId: conversation.id,
              turnId,
              type: "tool_call",
              callId: event.callId,
              name: event.name,
              args: event.args,
            });
            await bindPayload(callItem.id, event.payload);
            calls.push({ callId: event.callId, name: event.name, args: event.args });
            this.#emitKernel({
              type: "tool_call.started",
              conversationId: conversation.id,
              callId: event.callId,
              name: event.name,
              args: event.args,
            });
            break;
          }
          case "completed":
            completed = event;
            break;
          default:
            assertNever(event);
        }
      }
      await flushText(); // trailing text segment (saves partial output on abort)

      // --- Dispatch phase: one tool_result per recorded call, always. ---
      for (const call of calls) {
        const result = signal.aborted
          ? interruptedResult()
          : await this.#dispatchInterruptible(
              call,
              toolSet,
              conversation.id,
              turnId,
              signal,
              runtime,
            );
        await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "tool_result",
          callId: call.callId,
          content: result.forModel,
          status: result.status,
        });
        this.#emitKernel({
          type: "tool_call.completed",
          conversationId: conversation.id,
          callId: call.callId,
          status: result.status,
          forModel: result.forModel,
        });
      }

      // --- Finalize. ---
      if (lastMessageId) await bindPayload(lastMessageId, completed?.payload);
      // Before the abort throw: a completed-then-aborted step still records its spend.
      // Aborted mid-stream ⇒ no `completed` ⇒ no row.
      if (completed) {
        const { provider: providerName, model } = conversation.config.model;
        const recorded = await this.store.recordModelUsage({
          conversationId: conversation.id,
          turnId,
          contextBuildId: build.id,
          provider: providerName,
          model,
          usage: completed.usage,
          cost: pricing ? costOf(completed.usage, pricing) : null,
        });
        this.#emitKernel({
          type: "usage",
          conversationId: conversation.id,
          turnId,
          provider: providerName,
          model,
          usage: recorded.usage,
          cost: recorded.cost,
        });
      }
      if (signal.aborted) throw new TurnAborted();
      if (!completed) {
        throw new Error("provider stream ended without a 'completed' event");
      }
      if (calls.length === 0) {
        return; // final, non-tool response: the turn is done
      }

      // After-tool-result boundary: only steers flush into this turn; queued
      // entries wait for the next batch.
      const steers = runtime.takeSteers();
      if (steers.length > 0) this.#emitInbox(runtime);
      for (const steer of steers) {
        const message = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "message",
          role: "user",
          content: steer.input.content,
        });
        this.#emitKernel({ type: "message", conversationId: conversation.id, item: message });
      }
    }

    throw new Error(`turn exceeded ${MAX_MODEL_STEPS} model steps`);
  }

  /**
   * Races dispatch against abort: if abort wins, the call gets a synthetic
   * `interrupted` result and the tool is abandoned (cooperative tools also stop via
   * `ctx.signal`). Either way the call gets exactly one result.
   */
  #dispatchInterruptible(
    call: ToolCall,
    toolSet: ToolSet,
    conversationId: ConversationId,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<ToolResult> {
    if (signal.aborted) return Promise.resolve(interruptedResult());
    const aborted = new Promise<ToolResult>((resolve) => {
      signal.addEventListener("abort", () => resolve(interruptedResult()), { once: true });
    });
    return Promise.race([
      this.#dispatch(call, toolSet, conversationId, turnId, signal, runtime),
      aborted,
    ]);
  }

  /**
   * Turns one tool call into exactly one ToolResult — the single place the
   * "every tool_call gets one tool_result" invariant is enforced. The middleware
   * chain wraps the tool's `execute`; a failed or short-circuited call yields an
   * error result, never throwing past this point.
   */
  async #dispatch(
    call: ToolCall,
    toolSet: ToolSet,
    conversationId: ConversationId,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<ToolResult> {
    const ctx: ToolMiddlewareContext = {
      conversationId,
      callId: call.callId,
      signal,
      toolMeta: (name) => toolSet.metaOf(name),
      service: (key) => this.#service(runtime, key),
      // Default the dispatching conversation onto the event so a plugin can't emit an
      // unscoped (and thus silently dropped) event; an explicit id in the event still wins.
      emit: (event) => this.#emitPlugin({ conversationId, ...event }),
      // Plugin-origin delivery, fixed to `steer`, stamped with the dispatching tool's name.
      deliver: (content) =>
        void this.deliver(
          conversationId,
          { source: { kind: "plugin", pluginId: call.name }, content },
          "steer",
        ),
      putBlob: (bytes) => this.store.putBlob(bytes),
      request: (request) => this.#request(request, conversationId, signal, runtime),
      active: async () => compactedWindow(await this.store.listActiveItems(conversationId)),
      appendContext: async (key, content) => {
        const item = await this.store.appendItem({
          conversationId,
          turnId,
          type: "context",
          key,
          content,
        });
        this.#emitKernel({ type: "context", conversationId, item });
      },
    };
    const execute: ToolHandler = (c) => {
      if (!toolSet.has(c.name)) return Promise.resolve(errorResult(`unknown tool: ${c.name}`));
      const tool = toolSet.get(c.name);
      const parsed = parseToolArgs(tool, c.args);
      if (!parsed.ok) return Promise.resolve(parsed.result);
      return tool.execute(parsed.data, ctx);
    };
    try {
      return await runToolChain(this.host.toolMiddleware, call, ctx, execute);
    } catch (error) {
      return errorResult(`tool '${call.name}' failed: ${String(error)}`);
    }
  }

  /**
   * Host side of `ctx.request`: parks on a new request id until `respond` resolves it.
   * Abort-aware — on abort the entry is removed and the promise rejects, so nothing leaks.
   */
  #request(
    request: unknown,
    conversationId: ConversationId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<unknown> {
    const aborted = (): Error => new Error("interrupted: turn aborted");
    if (signal.aborted) return Promise.reject(aborted());
    const requestId = `req_${++this.#requestSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        runtime.pendingRequests.delete(requestId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      runtime.pendingRequests.set(requestId, {
        resolve: (response) => {
          cleanup();
          this.#emitKernel({ type: "request.resolved", requestId, conversationId });
          resolve(response);
        },
      });
      this.#emitKernel({ type: "request.created", requestId, conversationId, request });
    });
  }

  /**
   * Appends a `compaction` item if the strategy folds the window; otherwise a no-op.
   * Runs inside the turn's try so a strategy throw fails this turn, not the next.
   */
  async #maybeCompact(
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const window = compactedWindow(await this.store.listActiveItems(conversation.id));
    const content = await this.host.policies.compaction.compact({
      conversationId: conversation.id,
      items: window,
    });
    if (!content) return;
    const item = await this.store.appendItem({
      conversationId: conversation.id,
      turnId,
      type: "compaction",
      content,
    });
    this.#emitKernel({ type: "compaction", conversationId: conversation.id, item });
  }

  /** The model's rate card from its provider's catalog; undefined = cost not computable. */
  #pricingFor(model: ModelConfig): ModelPricing | undefined {
    return findModel(this.host.providers.listModels(), model)?.pricing;
  }

  async #buildContext(conversation: Conversation, tools: ToolSchema[]): Promise<ContextBuild> {
    // Use the active chain (not the raw log): after a rewind, abandoned-branch items
    // must stay out of context. Read `head` from the store, never off the cached
    // `Runtime.conversation` snapshot.
    const items = compactedWindow(await this.store.listActiveItems(conversation.id));
    const payloadList = await this.store.getProviderPayloads(items.map((i) => i.id));
    const payloads = new Map(payloadList.map((p) => [p.itemId, p]));
    const sourceInstructions = (
      await Promise.all(this.host.contextSources.map((s) => s.instructions()))
    ).flat();
    const instructions: ContentBlock[] = [
      { type: "text", text: conversation.config.instructions },
      ...sourceInstructions,
    ];

    const built: NewContextBuild = {
      conversationId: conversation.id,
      instructions,
      tools,
      items: items.map((item) => {
        const payload = payloads.get(item.id);
        return payload ? { item, payload } : { item };
      }),
    };
    return this.store.recordContextBuild(built);
  }

  /** The single scope-filtered fan-out behind the `#emit*` pair. */
  #broadcast(event: HarnessEvent): void {
    const scope = conversationOf(event);
    for (const { observer, scope: s } of this.#observers) {
      if (s === undefined || s === scope) observer.onEvent(event);
    }
  }

  /**
   * Emit a kernel event. Typed to the closed `KernelEvent` (not the open `HarnessEvent`) so a
   * literal that forgets `conversationId` is a compile error, not a silently untagged event.
   */
  #emitKernel(event: KernelEvent): void {
    this.#broadcast(event);
  }

  /** Emit a plugin-defined event; the `ctx.emit` seam guarantees it carries a `conversationId`. */
  #emitPlugin(event: PluginEvent): void {
    this.#broadcast(event);
  }

  /** Re-emit the conversation's current inbox snapshot; called after every inbox mutation. */
  #emitInbox(runtime: Runtime): void {
    this.#emitKernel({
      type: "inbox",
      conversationId: runtime.conversation.id,
      // Only queue/steer are "pending"; a send/interrupt passes through the buffer in the same
      // drain tick, so it never belongs in the snapshot — keeping the event true to its contract.
      pending: runtime.inbox
        .filter((d) => d.intent === "queue" || d.intent === "steer")
        .map((d) => ({ intent: d.intent, text: textOf(d.input.content) })),
    });
  }
}
