import {
  assertNever,
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
  type Store,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type TurnId,
} from "@harness/protocol";
import type { PluginHost } from "./plugin-host.ts";
import { Session, type Delivery } from "./session.ts";
import { applyDelivery } from "./delivery.ts";

const MAX_MODEL_STEPS = 100;

const errorResult = (text: string): ToolResult => ({
  forModel: [{ type: "text", text }],
  status: "error",
});

/**
 * The control loop: per conversation, a serialized drain loop turns mailbox
 * entries into Turns. Input arrives via `deliver`; the delivery module decides
 * how it joins the loop; the loop itself branches only on model/tool outcomes,
 * never on delivery intent. A turn that throws fails *that turn* and the loop
 * continues — a single conversation never crashes the process.
 */
export class Engine {
  readonly #observers: Observer[];
  readonly #sessions = new Map<ConversationId, Session>();
  readonly #loading = new Map<ConversationId, Promise<Session>>();

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
   * once the input is *accepted* (queued), not once its turn completes — that is
   * what lets input arrive while a turn is running. Await `whenIdle` for completion.
   */
  async deliver(
    conversationId: ConversationId,
    input: DeliveryInput,
    intent: DeliveryIntent = "send",
  ): Promise<void> {
    const session = await this.#session(conversationId);
    applyDelivery(session, { input, intent });
    this.#ensureRunning(session);
  }

  /** Resolves when the conversation's loop is idle and its mailbox is drained. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#sessions.get(conversationId)?.whenIdle() ?? Promise.resolve();
  }

  /** Loads (and caches) the session, guarding against concurrent first-touch. */
  #session(conversationId: ConversationId): Promise<Session> {
    const existing = this.#sessions.get(conversationId);
    if (existing) return Promise.resolve(existing);
    let loading = this.#loading.get(conversationId);
    if (!loading) {
      loading = this.#loadSession(conversationId);
      this.#loading.set(conversationId, loading);
    }
    return loading;
  }

  async #loadSession(conversationId: ConversationId): Promise<Session> {
    try {
      const conversation = await this.store.getConversation(conversationId);
      if (!conversation) {
        throw new Error(`unknown conversation: ${conversationId}`);
      }
      const session = new Session(conversation);
      this.#sessions.set(conversationId, session);
      return session;
    } finally {
      this.#loading.delete(conversationId);
    }
  }

  /** Starts the detached drain loop if it isn't already running. */
  #ensureRunning(session: Session): void {
    if (session.running) return;
    session.running = true;
    void this.#drain(session);
  }

  /**
   * Pulls one delivery at a time and runs it to completion. The empty-mailbox
   * check and `running = false` are synchronous and adjacent, so a concurrent
   * `deliver` either appends before this point (and is drained here) or after
   * (and restarts the loop) — never lost.
   */
  async #drain(session: Session): Promise<void> {
    for (;;) {
      const delivery = session.mailbox.shift();
      if (delivery === undefined) {
        session.running = false;
        session.signalIdle();
        return;
      }
      await this.#runTurn(session, delivery);
    }
  }

  async #runTurn(session: Session, delivery: Delivery): Promise<void> {
    const conversation = session.conversation;
    const controller = new AbortController();
    session.controller = controller;

    const turn = await this.store.createTurn(conversation.id);
    this.#emit({ type: "turn.status", turnId: turn.id, status: "running" });

    const inputMessage = await this.store.appendItem({
      conversationId: conversation.id,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: delivery.input.content,
    });
    this.#emit({ type: "message", item: inputMessage });

    try {
      await this.#runSteps(conversation, turn.id, controller.signal);
      await this.store.updateTurn(turn.id, "completed");
      this.#emit({ type: "turn.status", turnId: turn.id, status: "completed" });
    } catch (error) {
      await this.store.updateTurn(turn.id, "failed");
      this.#emit({ type: "turn.status", turnId: turn.id, status: "failed", error: String(error) });
    } finally {
      session.controller = undefined;
    }
  }

  async #runSteps(conversation: Conversation, turnId: TurnId, signal: AbortSignal): Promise<void> {
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      const build = await this.#buildContext(conversation);
      const request: ModelRequest = {
        instructions: build.instructions,
        items: build.items,
        tools: build.tools,
        modelConfig: conversation.config.model,
      };
      const provider = this.host.providers.get(conversation.config.model.provider);

      const toolCalls: ToolCall[] = [];
      let completed: Extract<ModelStreamEvent, { type: "completed" }> | undefined;

      for await (const event of provider.stream(request)) {
        switch (event.type) {
          case "text_delta":
            this.#emit({ type: "text_delta", turnId, text: event.text });
            break;
          case "tool_call":
            toolCalls.push({
              callId: event.callId,
              name: event.name,
              args: event.args,
            });
            break;
          case "completed":
            completed = event;
            break;
          default:
            assertNever(event);
        }
      }

      if (!completed) {
        throw new Error("provider stream ended without a 'completed' event");
      }

      // The item the step's reasoning payload binds to: the assistant message if
      // there is one, else the first tool call.
      let primaryItemId: ItemId | undefined;

      if (completed.content.length > 0) {
        const assistant = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "message",
          role: "assistant",
          content: completed.content,
        });
        this.#emit({ type: "message", item: assistant });
        primaryItemId = assistant.id;
      }

      for (const call of toolCalls) {
        const callItem = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "tool_call",
          callId: call.callId,
          name: call.name,
          args: call.args,
        });
        primaryItemId ??= callItem.id;
        this.#emit({
          type: "tool_call.started",
          callId: call.callId,
          name: call.name,
          args: call.args,
        });

        const result = await this.#dispatch(call, conversation.id, signal);

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

      if (completed.payload && primaryItemId) {
        await this.store.putProviderPayload({
          ...completed.payload,
          itemId: primaryItemId,
        });
      }

      if (toolCalls.length === 0) {
        return;
      }
    }

    throw new Error(`turn exceeded ${MAX_MODEL_STEPS} model steps`);
  }

  /**
   * Turns one tool call into exactly one ToolResult — the single place the
   * "every tool_call gets one tool_result" invariant is enforced. A denied or
   * failed call yields an error result; it never throws past this point.
   */
  async #dispatch(
    call: ToolCall,
    conversationId: ConversationId,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const verdict = await this.host.policies.toolGate.evaluate(call);
    if (verdict === "deny") {
      return errorResult(`tool '${call.name}' denied`);
    }
    if (verdict === "ask") {
      return errorResult(`tool '${call.name}' requires approval (not supported)`);
    }
    if (!this.host.tools.has(call.name)) {
      return errorResult(`unknown tool: ${call.name}`);
    }

    const tool = this.host.tools.get(call.name);
    const ctx: ToolContext = {
      conversationId,
      signal,
      emit: (event) => this.#emit(event),
    };
    try {
      const raw = await tool.execute(call.args, ctx);
      return await this.host.policies.output.project(raw, {
        putBlob: (bytes) => this.store.putBlob(bytes),
        toolName: call.name,
      });
    } catch (error) {
      return errorResult(`tool '${call.name}' failed: ${String(error)}`);
    }
  }

  async #buildContext(conversation: Conversation): Promise<ContextBuild> {
    const items = await this.store.listItems(conversation.id);
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
