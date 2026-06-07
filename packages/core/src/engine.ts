import {
  assertNever,
  type Conversation,
  type ConversationId,
  type ContentBlock,
  type ContextBuild,
  type DeliveryIntent,
  type Event,
  type ItemId,
  type LoopBoundary,
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

const MAX_MODEL_STEPS = 100;

export interface DeliveryMessage {
  text: string;
}

const errorResult = (text: string): ToolResult => ({
  forModel: [{ type: "text", text }],
  status: "error",
});

/**
 * The control loop: a state machine over a Turn. It advances state and, at each
 * boundary, asks the relevant policy and acts on the returned value. It contains
 * no branches on delivery *intent* — only on the action the policy returns.
 */
export class Engine {
  readonly #observers: Observer[];

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

  /** The single seam through which all input that wakes the agent flows. */
  async deliver(
    conversationId: ConversationId,
    message: DeliveryMessage,
    intent: DeliveryIntent = "send",
  ): Promise<void> {
    const conversation = await this.store.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`unknown conversation: ${conversationId}`);
    }
    const active = await this.store.getActiveTurn(conversationId);
    const boundary: LoopBoundary = active ? "before-model-step" : "idle";
    const action = this.host.policies.delivery.decide({
      intent,
      boundary,
      ...(active ? { turn: active } : {}),
    });

    switch (action) {
      case "start-turn":
        await this.#runTurn(conversation, message);
        return;
      case "hold":
        throw new Error("conversation is busy (queue/steer not yet supported)");
      case "inject":
      case "cancel-and-restart":
        throw new Error(`delivery action '${action}' not yet supported`);
      default:
        return assertNever(action);
    }
  }

  async #runTurn(conversation: Conversation, message: DeliveryMessage): Promise<void> {
    const conversationId = conversation.id;
    const turn = await this.store.createTurn({ conversationId });
    this.#emit({ type: "turn.status", turnId: turn.id, status: "running" });

    const userMessage = await this.store.appendItem({
      conversationId,
      turnId: turn.id,
      type: "message",
      role: "user",
      content: [{ type: "text", text: message.text }],
    });
    this.#emit({ type: "message", item: userMessage });

    try {
      await this.#runSteps(conversation, turn.id);
    } catch (error) {
      await this.store.updateTurn({ id: turn.id, status: "failed" });
      this.#emit({ type: "turn.status", turnId: turn.id, status: "failed" });
      throw error;
    }
  }

  async #runSteps(conversation: Conversation, turnId: TurnId): Promise<void> {
    const controller = new AbortController();

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

        const result = await this.#dispatch(call, conversation.id, controller.signal);

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
        await this.store.updateTurn({ id: turnId, status: "completed" });
        this.#emit({ type: "turn.status", turnId, status: "completed" });
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
      return this.host.policies.output.project(raw);
    } catch (error) {
      return errorResult(`tool '${call.name}' failed: ${String(error)}`);
    }
  }

  async #buildContext(conversation: Conversation): Promise<ContextBuild> {
    const items = await this.store.listItems(conversation.id);
    const payloadList = await this.store.getProviderPayloads(items.map((i) => i.id));
    const payloads = new Map(payloadList.map((p) => [p.itemId, p]));
    const sourceInstructions = (
      await Promise.all(this.host.contextSources.map((s) => Promise.resolve(s.instructions())))
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

  #emit(event: Event): void {
    for (const observer of this.#observers) {
      observer.onEvent(event);
    }
  }
}
