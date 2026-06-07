import {
  assertNever,
  errorResult,
  type Conversation,
  type ConversationId,
  type ContentBlock,
  type ContextBuild,
  type DeliveryInput,
  type DeliveryIntent,
  type HarnessEvent,
  type ItemId,
  type ModelRequest,
  type ModelStreamEvent,
  type Observer,
  type ProviderPayloadDraft,
  type Store,
  type ToolCall,
  type ToolHandler,
  type ToolMiddlewareContext,
  type ToolResult,
  type TurnId,
} from "@harness/protocol";
import type { PluginHost } from "./plugin-host.ts";
import { Runtime, type Delivery } from "./runtime.ts";
import { applyDelivery } from "./delivery.ts";
import { runToolChain } from "./compose.ts";
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
  readonly #observers: Observer[];
  readonly #runtimes = new Map<ConversationId, Runtime>();
  readonly #loading = new Map<ConversationId, Promise<Runtime>>();
  /** Monotonic source for ephemeral request ids (process-local; not durable). */
  #requestSeq = 0;

  constructor(
    private readonly store: Store,
    private readonly host: PluginHost,
  ) {
    this.#observers = [...host.observers];
  }

  /** Read-only event subscription. Returns an unsubscribe handle. */
  subscribe(observer: Observer): () => void {
    this.#observers.push(observer);
    return () => {
      const i = this.#observers.indexOf(observer);
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
    this.#ensureRunning(runtime);
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
      const conversation = await this.store.getConversation(conversationId);
      if (!conversation) {
        throw new Error(`unknown conversation: ${conversationId}`);
      }
      // Repair crash residue before a turn can start: a stale `running` turn would
      // wedge `createTurn`. Single-flighted by `#loading`, so it runs once.
      await reconcileConversation(this.store, conversationId);
      const runtime = new Runtime(conversation);
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
      await this.#runTurn(runtime, batch);
    }
    runtime.running = false;
    runtime.signalIdle();
  }

  /** Runs one turn seeded by a batch: each entry's content is a user message. */
  async #runTurn(runtime: Runtime, batch: Delivery[]): Promise<void> {
    const conversation = runtime.conversation;
    const controller = new AbortController();
    runtime.controller = controller;

    const turn = await this.store.createTurn(conversation.id);
    runtime.currentTurnId = turn.id;
    this.#emit({ type: "turn.status", turnId: turn.id, status: "running" });

    for (const delivery of batch) {
      const message = await this.store.appendItem({
        conversationId: conversation.id,
        turnId: turn.id,
        type: "message",
        role: "user",
        content: delivery.input.content,
      });
      this.#emit({ type: "message", item: message });
    }

    try {
      await this.#runSteps(conversation, turn.id, controller.signal, runtime);
      await this.store.updateTurn(turn.id, "completed");
      this.#emit({ type: "turn.status", turnId: turn.id, status: "completed" });
    } catch (error) {
      if (error instanceof TurnAborted) {
        await this.store.updateTurn(turn.id, "aborted");
        this.#emit({ type: "turn.status", turnId: turn.id, status: "aborted" });
      } else {
        await this.store.updateTurn(turn.id, "failed");
        this.#emit({
          type: "turn.status",
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
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      const build = await this.#buildContext(conversation);
      const request: ModelRequest = {
        instructions: build.instructions,
        items: build.items,
        tools: build.tools,
        modelConfig: conversation.config.model,
      };
      const provider = this.host.providers.get(conversation.config.model.provider);

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
        this.#emit({ type: "message", item: message });
        pendingText = "";
      };

      // --- Consume phase: assistant content, in emission order. ---
      for await (const event of provider.stream(request, signal)) {
        if (signal.aborted) break;
        switch (event.type) {
          case "text_delta":
            pendingText += event.text;
            this.#emit({ type: "text_delta", turnId, text: event.text });
            break;
          case "reasoning_delta":
            this.#emit({ type: "reasoning_delta", turnId, text: event.text });
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
            this.#emit({ type: "reasoning", item });
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
            this.#emit({
              type: "tool_call.started",
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
          : await this.#dispatchInterruptible(call, conversation.id, signal, runtime);
        await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "tool_result",
          callId: call.callId,
          content: result.forModel,
          status: result.status,
        });
        this.#emit({
          type: "tool_call.completed",
          callId: call.callId,
          status: result.status,
          forModel: result.forModel,
        });
      }

      // --- Finalize. ---
      if (lastMessageId) await bindPayload(lastMessageId, completed?.payload);
      if (signal.aborted) throw new TurnAborted();
      if (!completed) {
        throw new Error("provider stream ended without a 'completed' event");
      }
      if (calls.length === 0) {
        return; // final, non-tool response: the turn is done
      }

      // After-tool-result boundary: only steers flush into this turn; queued
      // entries wait for the next batch.
      for (const steer of runtime.takeSteers()) {
        const message = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "message",
          role: "user",
          content: steer.input.content,
        });
        this.#emit({ type: "message", item: message });
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
    conversationId: ConversationId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<ToolResult> {
    if (signal.aborted) return Promise.resolve(interruptedResult());
    const aborted = new Promise<ToolResult>((resolve) => {
      signal.addEventListener("abort", () => resolve(interruptedResult()), { once: true });
    });
    return Promise.race([this.#dispatch(call, conversationId, signal, runtime), aborted]);
  }

  /**
   * Turns one tool call into exactly one ToolResult — the single place the
   * "every tool_call gets one tool_result" invariant is enforced. The middleware
   * chain wraps the tool's `execute`; a failed or short-circuited call yields an
   * error result, never throwing past this point.
   */
  async #dispatch(
    call: ToolCall,
    conversationId: ConversationId,
    signal: AbortSignal,
    runtime: Runtime,
  ): Promise<ToolResult> {
    const ctx: ToolMiddlewareContext = {
      conversationId,
      signal,
      emit: (event) => this.#emit(event),
      putBlob: (bytes) => this.store.putBlob(bytes),
      request: (request) => this.#request(request, conversationId, signal, runtime),
    };
    const execute: ToolHandler = (c) =>
      this.host.tools.has(c.name)
        ? this.host.tools.get(c.name).execute(c.args, ctx)
        : Promise.resolve(errorResult(`unknown tool: ${c.name}`));
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
          this.#emit({ type: "request.resolved", requestId, conversationId });
          resolve(response);
        },
      });
      this.#emit({ type: "request.created", requestId, conversationId, request });
    });
  }

  async #buildContext(conversation: Conversation): Promise<ContextBuild> {
    // Active chain, not raw log: after a rewind, abandoned-branch items must stay
    // out of context. The store owns `head`; never read it off the cached
    // `Runtime.conversation` snapshot.
    const items = await this.store.listActiveItems(conversation.id);
    const payloadList = await this.store.getProviderPayloads(items.map((i) => i.id));
    const payloads = new Map(payloadList.map((p) => [p.itemId, p]));
    const sourceInstructions = (
      await Promise.all(this.host.contextSources.map((s) => s.instructions()))
    ).flat();
    const instructions: ContentBlock[] = [
      { type: "text", text: conversation.config.instructions },
      ...sourceInstructions,
    ];

    return this.store.recordContextBuild(
      await this.host.policies.context.select({
        conversationId: conversation.id,
        instructions,
        tools: this.host.tools.schemas(),
        items,
        payloads,
      }),
    );
  }

  #emit(event: HarnessEvent): void {
    for (const observer of this.#observers) {
      observer.onEvent(event);
    }
  }
}
