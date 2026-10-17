import { AsyncLocalStorage } from "node:async_hooks";
import { WorkspaceOperationError } from "@harness/protocol";
import { relative, isAbsolute } from "node:path";
import { InteractionTimeoutError, type RequestOptions } from "@harness/protocol";
import { randomUUID } from "node:crypto";
import {
  assertNever,
  ContextWindowExceededError,
  ModelInvocationFailure,
  conversationOf,
  costOf,
  errorResult,
  formatError,
  findModel,
  textOf,
  type ConfigResolver,
  type CodeEvaluator,
  type Conversation,
  type ConversationConfig,
  type ConversationId,
  type ContentBlock,
  type DeliveryInput,
  type DeliveryIntent,
  type HarnessEvent,
  type Item,
  type ItemId,
  type JsonValue,
  type KernelEvent,
  type ModelConfig,
  type ModelIdentity,
  type ModelIdentityChange,
  type ModelInfo,
  type ModelInvocationResult,
  type ModelInvoker,
  type ModelOutputItem,
  type ModelPricing,
  type ModelProvider,
  type ModelRequest,
  type ModelCallContext,
  type ModelStreamEvent,
  type NewContextBuild,
  type Observer,
  type InteractionRequest,
  type PluginEvent,
  type RequestMiddlewareContext,
  type Store,
  type ToolCall,
  type ToolHandler,
  type ToolMiddlewareContext,
  type ToolResult,
  type ToolSchema,
  type TurnId,
} from "@harness/protocol";
import type { PluginHost } from "./plugin-host.ts";
import { ToolSet } from "./registry.ts";
import {
  evaluatorTool,
  EVALUATOR_NAME,
  modelSchemas,
  upfrontTools,
  allowsDirect,
} from "./code-mode.ts";
import { discoveryTools, isDiscoveryTool } from "./tool-discovery.ts";
import { parseToolArgs } from "./tools.ts";
import { compactedWindow, estimateContextTokens, fallbackCompaction } from "./policies.ts";
import { Runtime, type Delivery } from "./runtime.ts";
import { applyDelivery } from "./delivery.ts";
import { runModelChain, runToolChain } from "./compose.ts";
import { runRequestChain } from "./compose.ts";
import { reconcileConversation } from "./reconcile.ts";
import { ModelPreview } from "./model-preview.ts";

const MAX_MODEL_STEPS = 100;

interface PendingContext {
  key: string;
  content: ContentBlock[];
}

interface DispatchOutcome {
  result: ToolResult;
  completed: boolean;
}

export type DeactivationResult = { status: "busy" } | { status: "deactivated" };

export interface ConversationTreeMemberState {
  conversation: Conversation;
  status: "idle" | "running";
  turnId: TurnId | null;
  pendingInput: { intent: "queue" | "steer"; text: string }[];
}

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
 * The control loop: one Engine per process drives loaded per-conversation runtimes.
 * It branches only on model/tool outcomes, never on delivery intent (that mapping
 * lives in `delivery.ts`). A throwing turn fails only that turn — the drain loop
 * continues, so one conversation never crashes the process.
 */
export class Engine {
  /** Each observer with its optional conversation scope; unscoped ones see every event. */
  readonly #observers: { observer: Observer; scope?: ConversationId }[];
  readonly #runtimes = new Map<ConversationId, Runtime>();
  readonly #deletingWorkspaces = new Set<string>();
  readonly #workspaceOperations = new Map<string, number>();
  readonly #loading = new Map<ConversationId, Promise<Runtime>>();
  /** Ephemeral ownership for loaded roots and children created during this process. */
  readonly #roots = new Map<ConversationId, ConversationId>();
  readonly #closingRoots = new Set<ConversationId>();
  /** Prevents stale plugin callbacks from reviving a closed root scope; `prepare(root)` reopens it. */
  readonly #closedRoots = new Set<ConversationId>();
  /** Monotonic source for ephemeral request ids (process-local; not durable). */
  #requestSeq = 0;

  constructor(
    private readonly store: Store,
    private readonly host: PluginHost,
    /** Derives a conversation's config from its record on every load — injected so core stays free
     *  of `@harness/config`. */
    private readonly resolveConfig: ConfigResolver,
    private readonly codeEvaluator: CodeEvaluator,
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
    // Plugin completion notices may race teardown. They belong to the closing activation and must
    // not recreate it; direct callers still receive an honest rejection for unaccepted input.
    if (this.#rootScopeUnavailable(conversationId)) {
      if (input.source.kind === "plugin") return;
      throw new Error("cannot deliver input during conversation deactivation");
    }
    const runtime = await this.#runtime(conversationId);
    this.assertWorkspaceAvailable(runtime.conversation.workspaceRoot);
    if (this.#rootScopeUnavailable(conversationId)) {
      if (input.source.kind === "plugin") return;
      throw new Error("cannot deliver input during conversation deactivation");
    }
    if (runtime.workspaceSwitch) {
      if (intent === "interrupt") {
        runtime.workspaceSwitch.controller.abort();
        await runtime.workspaceSwitch.done.catch(() => undefined);
      } else
        throw new WorkspaceOperationError("Workspace switch in progress; retry after it completes");
    }
    if (runtime.preparation) {
      if (intent === "interrupt") {
        runtime.preparation.controller.abort();
        await runtime.preparation.done.catch(() => undefined);
      } else throw new Error("Workspace is preparing; retry after it completes");
    }
    if (
      this.#rootScopeUnavailable(conversationId) ||
      this.#runtimes.get(conversationId) !== runtime
    )
      throw new Error("Conversation closed during workspace interruption");
    if (
      input.source.kind === "user" &&
      input.content.some((block) => block.type !== "text" || block.text.length > 0)
    )
      this.store.recordUserInput(conversationId);
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
    const root = this.#rootOf(conversationId);
    if (conversationId === root) this.#closedRoots.delete(root);
    const runtime = await this.#runtime(conversationId);
    this.assertWorkspaceAvailable(runtime.conversation.workspaceRoot);
    if (this.#rootScopeUnavailable(conversationId)) {
      throw new Error("cannot prepare a conversation during deactivation");
    }
    const execution = this.#service(runtime, "execution") as
      | {
          bind?: (emit: (event: PluginEvent) => void) => void | Promise<unknown>;
          prepare?: (signal?: AbortSignal) => Promise<void>;
        }
      | undefined;
    if (runtime.preparation) return runtime.preparation.done;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        await execution?.bind?.((event) => {
          if (
            this.#runtimes.get(conversationId) === runtime &&
            !this.#rootScopeUnavailable(conversationId)
          )
            this.#emitPlugin({ conversationId, ...event });
        });
        controller.signal.throwIfAborted();
        await execution?.prepare?.(controller.signal);
      })
      .finally(() => {
        runtime.preparation = undefined;
      });
    runtime.preparation = { controller, done };
    return done;
  }

  /**
   * Answers a pending `ctx.request` raised by a middleware. Point-to-point and
   * correlated by id — deliberately not routed through the inbox/delivery intents.
   * A no-op if the request is unknown (already resolved, or cancelled by abort).
   */
  respond(conversationId: ConversationId, requestId: string, response: unknown): void {
    this.#runtimes.get(conversationId)?.pendingRequests.get(requestId)?.resolve(response);
  }

  pendingRequests(rootId: ConversationId) {
    return this.#treeRuntimes(rootId).flatMap((runtime) =>
      [...runtime.pendingRequests].map(([requestId, pending]) => ({
        requestId,
        conversationId: runtime.conversation.id,
        request: pending.request,
      })),
    );
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
    this.#emitKernel({ type: "head.changed", conversationId, head: toItemId });
  }

  /** Runs a standalone, summary-only compaction turn. Refuses to interrupt active work. */
  async compact(
    conversationId: ConversationId,
    signal?: AbortSignal,
  ): Promise<"compacted" | "noop"> {
    const runtime = await this.#runtime(conversationId);
    if (runtime.running) {
      throw new Error(`cannot compact conversation ${conversationId} while a turn is running`);
    }
    // Reserve synchronously before the first await so delivery cannot start a competing turn.
    runtime.running = true;
    const conversation = runtime.conversation;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    runtime.controller = controller;
    try {
      if (controller.signal.aborted) throw new TurnAborted();
      if ((await this.store.listActiveItems(conversationId)).length === 0) return "noop";
      if (controller.signal.aborted) throw new TurnAborted();
      const turn = await this.store.createTurn(conversation.id);
      runtime.currentTurnId = turn.id;
      this.#emitKernel({
        type: "turn.status",
        conversationId: conversation.id,
        turnId: turn.id,
        status: "running",
      });
      try {
        const provider = this.host.providers.get(conversation.config.model.provider);
        provider.validateConfig(conversation.config.model);
        const toolSet = await this.#resolveTools(conversation, runtime);
        const build = await this.#assembleContext(
          conversation,
          modelSchemas(toolSet, conversation.config.tools?.mode ?? "hybrid"),
          runtime,
          toolSet,
        );
        const folded = await this.#compact(
          "manual",
          conversation,
          turn.id,
          controller.signal,
          runtime,
          toolSet,
          build,
          (await this.#contextCapacity(conversation, build)).compactionOutputLimit,
        );
        await this.store.updateTurn(turn.id, "completed");
        await this.#publishUsage(conversation.id);
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: "completed",
        });
        return folded ? "compacted" : "noop";
      } catch (error) {
        const aborted = error instanceof TurnAborted || controller.signal.aborted;
        await this.store.updateTurn(turn.id, aborted ? "aborted" : "failed");
        await this.#publishUsage(conversation.id);
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: aborted ? "aborted" : "failed",
          ...(!aborted ? { error: formatError(error) } : {}),
        });
        throw aborted && !(error instanceof TurnAborted) ? new TurnAborted() : error;
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      runtime.currentTurnId = undefined;
      runtime.controller = undefined;
      if (runtime.inbox.length > 0) {
        void this.#drain(runtime);
      } else {
        runtime.running = false;
        runtime.signalIdle();
      }
    }
  }

  /** Requests cancellation without disposing root-owned services. Teardown waits separately. */
  cancel(rootConversationId: ConversationId): void {
    const rootId = this.#rootOf(rootConversationId);
    for (const runtime of this.#treeRuntimes(rootId)) {
      runtime.inbox.splice(0);
      this.#emitInbox(runtime);
      runtime.controller?.abort();
      for (const provider of this.host.services.values()) {
        if (runtime.services.has(provider.key))
          provider.cancel?.(runtime.services.get(provider.key));
      }
    }
  }

  /** Resolves when the conversation's loop is idle and its inbox is drained. */
  whenIdle(conversationId: ConversationId): Promise<void> {
    return this.#runtimes.get(conversationId)?.whenIdle() ?? Promise.resolve();
  }

  /** Bounded synchronous projection of already-loaded authority for attachment. */
  conversationTreeState(rootConversationId: ConversationId): ConversationTreeMemberState[] {
    const root = this.#rootOf(rootConversationId);
    return this.#treeRuntimes(root).map((runtime) => ({
      conversation: runtime.conversation,
      status: runtime.running ? "running" : "idle",
      turnId: runtime.currentTurnId ?? null,
      pendingInput: runtime.inbox
        .filter(
          (delivery): delivery is Delivery & { intent: "queue" | "steer" } =>
            delivery.intent === "queue" || delivery.intent === "steer",
        )
        .map((delivery) => ({
          intent: delivery.intent,
          text: textOf(delivery.input.content),
        })),
    }));
  }

  rootConversationOf(conversationId: ConversationId): ConversationId {
    return this.#rootOf(conversationId);
  }

  /** Registers a freshly created child before it can be loaded or receive input. */
  registerChild(parentId: ConversationId, childId: ConversationId): void {
    if (this.#roots.has(childId)) {
      throw new Error(`conversation ${childId} already belongs to a conversation tree`);
    }
    const root = this.#rootOf(parentId);
    if (this.#closingRoots.has(root) || this.#closedRoots.has(root)) {
      throw new Error(`cannot create a child while root scope ${root} is closing`);
    }
    if (!this.#runtimes.has(parentId) && !this.#roots.has(parentId)) {
      throw new Error(`cannot create a child for inactive parent ${parentId}`);
    }
    this.#roots.set(childId, root);
  }

  /**
   * Tears down the complete loaded conversation tree. The root guard is checked synchronously before
   * teardown starts, so a refused switch changes nothing. Once accepted, late plugin completion
   * notices are ignored and every loaded runtime is discarded together. The production TUI ensures
   * that set is one top-level conversation plus its descendants.
   */
  /** The same turn, inbox and plugin blockers protect close and idle server replacement. */
  isSessionBusy(conversationId: ConversationId): boolean {
    const rootId = this.#rootOf(conversationId);
    return (
      this.#treeRuntimes(rootId).some(
        (runtime) =>
          runtime.running ||
          runtime.inbox.length > 0 ||
          runtime.workspaceSwitch !== undefined ||
          runtime.preparation !== undefined,
      ) || this.#treeHasDeactivationBlocker(rootId)
    );
  }

  async deactivate(
    rootConversationId: ConversationId,
    options: { force?: boolean } = {},
  ): Promise<DeactivationResult> {
    const rootId = this.#rootOf(rootConversationId);
    if (this.#closingRoots.has(rootId)) {
      throw new Error("conversation deactivation already in progress");
    }
    if (!options.force && this.isSessionBusy(rootId)) {
      return { status: "busy" };
    }

    this.#closingRoots.add(rootId);
    const errors: Error[] = [];
    try {
      // A prepare/deliver already past its first lookup belongs to this activation too.
      const loading = [...this.#loading.entries()]
        .filter(([id]) => this.#rootOf(id) === rootId)
        .map(([, promise]) => promise);
      await Promise.allSettled(loading);
      const runtimes = this.#treeRuntimes(rootId);

      this.cancel(rootId);
      for (const runtime of runtimes) {
        runtime.workspaceSwitch?.controller.abort();
        runtime.preparation?.controller.abort();
      }
      await Promise.allSettled(
        runtimes.flatMap((runtime) =>
          [runtime.workspaceSwitch, runtime.preparation].flatMap((operation) =>
            operation ? [operation.done] : [],
          ),
        ),
      );
      await Promise.all(runtimes.map((runtime) => runtime.whenIdle()));

      // Providers are registered outside-in; dispose in reverse so orchestration/resources (for
      // example activities) settle before the execution substrate they use is removed.
      for (const provider of [...this.host.services.values()].reverse()) {
        if (!provider.dispose) continue;
        const settled = await Promise.allSettled(
          runtimes
            .filter((runtime) => runtime.services.has(provider.key))
            .map((runtime) =>
              Promise.resolve().then(() => provider.dispose!(runtime.services.get(provider.key))),
            ),
        );
        for (const result of settled) {
          if (result.status === "rejected") {
            errors.push(
              new Error(`${provider.key}: ${formatError(result.reason)}`, {
                cause: result.reason,
              }),
            );
          }
        }
      }

      for (const runtime of runtimes) {
        runtime.services.clear();
        this.#runtimes.delete(runtime.conversation.id);
      }
      this.#closedRoots.add(rootId);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `conversation cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
        );
      }
      return { status: "deactivated" };
    } finally {
      this.#closingRoots.delete(rootId);
    }
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

  /** Read an already-created service without constructing it; used by bounded attach snapshots. */
  existingServiceFor(conversationId: ConversationId, key: string): unknown {
    return this.#runtimes.get(conversationId)?.services.get(key);
  }

  /** Resolve-and-cache a service for a runtime, building it from its provider on first use. */
  #service(runtime: Runtime, key: string): unknown {
    this.assertWorkspaceAvailable(runtime.conversation.workspaceRoot);
    if (runtime.workspaceSwitch && !runtime.workspaceSwitch.deferred)
      throw new WorkspaceOperationError("Workspace switch in progress");
    if (runtime.services.has(key)) return runtime.services.get(key);
    if (
      this.#runtimes.get(runtime.conversation.id) !== runtime ||
      this.#rootScopeUnavailable(runtime.conversation.id)
    ) {
      throw new Error("cannot construct a service for an inactive runtime");
    }
    const built = this.host.services.get(key)?.for(runtime.conversation);
    runtime.services.set(key, built);
    return built;
  }

  /** Aggregate model catalog across registered providers. */
  availableModels(): ModelInfo[] {
    return this.host.providers.listModels();
  }

  async setTitle(conversationId: ConversationId, title: string): Promise<void> {
    const runtime = await this.#runtime(conversationId);
    if (!(await this.#updateTitle(runtime, title, runtime.conversation.title)))
      throw new Error("Conversation title changed; try renaming again");
  }

  async forkSettings(conversationId: ConversationId) {
    const runtime = await this.#runtime(conversationId);
    const conversation = runtime.conversation;
    const tools = await this.#resolveTools(conversation, runtime);
    return {
      config: conversation.config,
      toolNames: tools
        .schemas()
        .map((tool) => tool.name)
        .filter((name) => name !== EVALUATOR_NAME && !isDiscoveryTool(name)),
    };
  }

  /** Changes model identity atomically. The previous model's preset is never inherited. */
  async setModel(
    conversationId: ConversationId,
    identity: ModelIdentityChange,
  ): Promise<ModelConfig> {
    if (Object.hasOwn(identity, "preset")) {
      throw new Error("setModel changes identity only; use setPreset to change a preset");
    }
    const model: ModelConfig = { provider: identity.provider, model: identity.model };
    this.host.providers.get(model.provider).validateConfig(model);
    return (await this.#updateOverrides(conversationId, { model })).model;
  }

  /** Changes only the current model's preset; `undefined` restores its provider-defined default. */
  async setPreset(
    conversationId: ConversationId,
    expected: ModelIdentity,
    preset: string | undefined,
  ): Promise<ModelConfig> {
    const record = await this.store.getConversation(conversationId);
    if (!record) throw new Error(`unknown conversation: ${conversationId}`);
    const current = await this.resolveConfig(record);
    if (current.model.provider !== expected.provider || current.model.model !== expected.model) {
      throw new Error(
        `model changed before preset update (expected ${expected.provider}/${expected.model}, current ${current.model.provider}/${current.model.model})`,
      );
    }
    const model: ModelConfig = {
      provider: current.model.provider,
      model: current.model.model,
      ...(preset !== undefined ? { preset } : {}),
    };
    this.host.providers.get(model.provider).validateConfig(model);
    return (await this.#updateOverrides(conversationId, { model })).model;
  }

  assertWorkspaceAvailable(path: string | null): void {
    if (!path) return;
    for (const root of this.#deletingWorkspaces) {
      const suffix = relative(root, path);
      if (
        !isAbsolute(suffix) &&
        suffix !== ".." &&
        !suffix.startsWith("../") &&
        !suffix.startsWith("..\\")
      )
        throw new WorkspaceOperationError("Worktree deletion is in progress");
    }
  }

  /** Short administrative workspace preparation also excludes checkout deletion. */
  async runWorkspaceOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    this.assertWorkspaceAvailable(path);
    this.#workspaceOperations.set(path, (this.#workspaceOperations.get(path) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = this.#workspaceOperations.get(path)! - 1;
      if (count) this.#workspaceOperations.set(path, count);
      else this.#workspaceOperations.delete(path);
    }
  }

  async deleteWorkspace(path: string, remove: () => Promise<void>): Promise<void> {
    this.assertWorkspaceAvailable(path);
    this.assertWorkspaceIdle(path);
    this.#deletingWorkspaces.add(path);
    try {
      await remove();
    } finally {
      this.#deletingWorkspaces.delete(path);
    }
  }

  assertWorkspaceIdle(path: string): void {
    for (const active of this.#workspaceOperations.keys()) {
      const suffix = relative(path, active);
      if (
        !isAbsolute(suffix) &&
        suffix !== ".." &&
        !suffix.startsWith("../") &&
        !suffix.startsWith("..\\")
      )
        throw new WorkspaceOperationError(
          "Workspace preparation is in progress; wait before deleting it",
        );
    }
    for (const runtime of this.#runtimes.values()) {
      if (
        [runtime.pendingWorkspace, runtime.workspaceSwitch?.target].some((target) => {
          if (!target) return false;
          const suffix = relative(path, target);
          return (
            !isAbsolute(suffix) &&
            suffix !== ".." &&
            !suffix.startsWith("../") &&
            !suffix.startsWith("..\\")
          );
        })
      )
        throw new WorkspaceOperationError("A conversation is switching into this worktree");
      const cwd = runtime.conversation.workspaceRoot;
      if (!cwd) continue;
      const suffix = relative(path, cwd);
      if (
        isAbsolute(suffix) ||
        suffix === ".." ||
        suffix.startsWith("../") ||
        suffix.startsWith("..\\")
      )
        continue;
      if (
        runtime.pendingWorkspace === path ||
        this.isSessionBusy(this.#rootOf(runtime.conversation.id))
      )
        throw new WorkspaceOperationError(
          "Stop conversations and background work in this worktree before deleting it",
        );
    }
  }

  async switchWorkspace(
    conversationId: ConversationId,
    resolveTarget: (signal: AbortSignal) => Promise<string>,
    deferred = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = await this.#runtime(conversationId);
    this.assertWorkspaceAvailable(runtime.conversation.workspaceRoot);
    signal?.throwIfAborted();
    if (runtime.workspaceSwitch || runtime.preparation || runtime.pendingWorkspace)
      throw new WorkspaceOperationError("A workspace switch is already pending");
    if (this.#treeHasDeactivationBlocker(this.#rootOf(conversationId)))
      throw new WorkspaceOperationError(
        "Stop background activities and subagents before switching workspaces",
      );
    if (deferred && !runtime.currentTurnId)
      throw new Error("No active turn for deferred workspace switch");
    if (!deferred && (runtime.running || runtime.inbox.length))
      throw new WorkspaceOperationError(
        "Wait for the conversation to become idle before switching workspaces",
      );
    await this.#replaceWorkspace(runtime, resolveTarget, deferred, signal);
  }

  #replaceWorkspace(
    runtime: Runtime,
    resolveTarget: string | ((signal: AbortSignal) => Promise<string>),
    deferred = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([
      controller.signal,
      ...[runtime.controller?.signal, signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    ]);
    const operation = {
      deferred,
      target: typeof resolveTarget === "string" ? resolveTarget : undefined,
      controller,
      done: Promise.resolve(),
    };
    operation.done = Promise.resolve()
      .then(async () => {
        combined.throwIfAborted();
        const target =
          typeof resolveTarget === "string" ? resolveTarget : await resolveTarget(combined);
        operation.target = target;
        combined.throwIfAborted();
        this.assertWorkspaceAvailable(target);
        if (deferred) runtime.pendingWorkspace = target;
        else await this.#commitWorkspace(runtime, target, combined);
      })
      .finally(() => {
        runtime.workspaceSwitch = undefined;
      });
    runtime.workspaceSwitch = operation;
    return operation.done;
  }

  async #commitWorkspace(
    runtime: Runtime,
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#treeHasDeactivationBlocker(this.#rootOf(runtime.conversation.id)))
      throw new WorkspaceOperationError(
        "Stop background activities and subagents before switching workspaces",
      );
    const previous = runtime.conversation;
    if (!previous.workspaceRoot)
      throw new Error("Projectless conversations cannot switch worktrees");
    if (previous.workspaceRoot === workspaceRoot) return;
    signal.throwIfAborted();
    const replacements = new Map<string, unknown>();
    let committed = false;
    try {
      const next = {
        ...previous,
        workspaceRoot,
        originalWorkspaceRoot: previous.originalWorkspaceRoot ?? previous.workspaceRoot,
      };
      for (const provider of this.host.services.values()) {
        if (provider.scope === "workspace") replacements.set(provider.key, provider.for(next));
      }
      const execution = replacements.get("execution") as
        | {
            bind?: (emit: (event: PluginEvent) => void) => void | Promise<unknown>;
            prepare?: (signal?: AbortSignal) => Promise<void>;
          }
        | undefined;
      await execution?.bind?.((event) =>
        this.#emitPlugin({ conversationId: previous.id, ...event }),
      );
      await execution?.prepare?.(signal);
      signal.throwIfAborted();
      if (this.#rootScopeUnavailable(previous.id)) throw new Error("Conversation is closing");
      this.assertWorkspaceAvailable(workspaceRoot);
      const record = await this.store.updateConversationWorkspace(previous.id, workspaceRoot);
      const oldServices = new Map<string, unknown>();
      for (const [key, service] of replacements) {
        if (runtime.services.has(key)) oldServices.set(key, runtime.services.get(key));
        runtime.services.set(key, service);
      }
      runtime.setConversation({ ...record, config: runtime.conversation.config });
      committed = true;
      this.#emitKernel({
        type: "workspace.changed",
        conversationId: previous.id,
        workspaceRoot,
        originalWorkspaceRoot: next.originalWorkspaceRoot,
      });
      const disposed = await Promise.allSettled(
        [...oldServices].map(([key, service]) =>
          Promise.resolve().then(() => this.host.services.get(key)?.dispose?.(service)),
        ),
      );
      const failures = disposed.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new Error("Workspace switched, but previous workspace cleanup failed");
    } finally {
      if (!committed) {
        await Promise.all(
          [...replacements].map(([key, service]) =>
            Promise.resolve().then(() => this.host.services.get(key)?.dispose?.(service)),
          ),
        );
      }
    }
  }

  /** Applies the already-validated durable plugin override layer. */
  async updatePluginOverrides(
    conversationId: ConversationId,
    plugins: Record<string, unknown>,
  ): Promise<void> {
    await this.#updateOverrides(conversationId, { plugins });
  }

  /** Applies a durable top-layer settings patch, re-resolves, and refreshes the live runtime. */
  async #updateOverrides(
    conversationId: ConversationId,
    patch: Record<string, unknown>,
  ): Promise<ConversationConfig> {
    await this.store.updateConversationOverrides(conversationId, patch);
    const record = await this.store.getConversation(conversationId);
    if (!record) throw new Error(`unknown conversation: ${conversationId}`);
    const config = await this.resolveConfig(record);
    const runtime = this.#runtimes.get(conversationId);
    if (runtime && !this.#rootScopeUnavailable(conversationId))
      runtime.setConversation({ ...runtime.conversation, overrides: record.overrides, config });
    this.#emitKernel({ type: "config.changed", conversationId, config });
    return config;
  }

  /**
   * The resolved config of a live runtime, or `undefined` when none is loaded. Backs the config
   * reader's hot path (a tool call always runs inside a loaded runtime); never loads a runtime.
   */
  configFor(conversationId: ConversationId): ConversationConfig | undefined {
    return this.#runtimes.get(conversationId)?.conversation.config;
  }

  /** Reconcile selected global plugin defaults without changing model or service-backed config. */
  async refreshPluginDefaults(pluginIds: readonly string[]): Promise<void> {
    // Already-loading activations may have read the old defaults. Failed loads retain their
    // existing caller-owned error; successful ones must join this reconciliation snapshot.
    await Promise.allSettled([...this.#loading.values()]);
    for (const runtime of [...this.#runtimes.values()]) {
      const id = runtime.conversation.id;
      const record = await this.store.getConversation(id);
      if (!record) throw new Error(`unknown loaded conversation: ${id}`);
      const resolved = await this.resolveConfig(record);
      // Resolution can overlap teardown; never update a replacement or closing activation.
      if (this.#runtimes.get(id) !== runtime || this.#rootScopeUnavailable(id)) continue;
      const current = runtime.conversation;
      const plugins = { ...current.config.plugins };
      for (const pluginId of pluginIds) {
        if (!resolved.plugins || !Object.hasOwn(resolved.plugins, pluginId))
          throw new Error(`missing resolved config for plugin '${pluginId}'`);
        plugins[pluginId] = resolved.plugins[pluginId];
      }
      const config = { ...current.config, plugins };
      runtime.setConversation({ ...current, config });
      this.#emitKernel({ type: "config.changed", conversationId: id, config });
    }
  }

  /** Loads (and caches) the runtime, guarding against concurrent first-touch. */
  #runtime(conversationId: ConversationId): Promise<Runtime> {
    if (this.#rootScopeUnavailable(conversationId)) {
      return Promise.reject(new Error("cannot load a conversation during deactivation"));
    }
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
      // Failed first loads own no tree. Registered children already retain their
      // parent mapping, and successful roots acquire ownership here.
      if (!this.#roots.has(conversationId)) this.#roots.set(conversationId, conversationId);
      this.#runtimes.set(conversationId, runtime);
      return runtime;
    } finally {
      this.#loading.delete(conversationId);
    }
  }

  #rootOf(conversationId: ConversationId): ConversationId {
    return this.#roots.get(conversationId) ?? conversationId;
  }

  #rootScopeUnavailable(conversationId: ConversationId): boolean {
    const root = this.#rootOf(conversationId);
    return this.#closingRoots.has(root) || this.#closedRoots.has(root);
  }

  #treeRuntimes(root: ConversationId): Runtime[] {
    return [...this.#runtimes.values()].filter(
      (runtime) => this.#rootOf(runtime.conversation.id) === root,
    );
  }

  #treeHasDeactivationBlocker(root: ConversationId): boolean {
    for (const runtime of this.#treeRuntimes(root)) {
      for (const provider of this.host.services.values()) {
        if (!provider.blocksDeactivation || !runtime.services.has(provider.key)) continue;
        if (provider.blocksDeactivation(runtime.services.get(provider.key))) return true;
      }
    }
    return false;
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

    try {
      for (const delivery of batch) {
        const message = await this.store.appendItem({
          conversationId: conversation.id,
          turnId: turn.id,
          type: "message",
          role: "user",
          content: delivery.input.content,
        });
        this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item: message });
        await this.#notifyInput(
          runtime,
          conversation,
          turn.id,
          delivery.input,
          message,
          controller.signal,
        );
      }

      await this.#runSteps(conversation, turn.id, controller.signal, runtime);
      if (controller.signal.aborted) throw new TurnAborted();
      await this.store.updateTurn(turn.id, "completed");
      await this.#publishUsage(conversation.id);
      this.#emitKernel({
        type: "turn.status",
        conversationId: conversation.id,
        turnId: turn.id,
        status: "completed",
      });
    } catch (error) {
      if (error instanceof TurnAborted || controller.signal.aborted) {
        await this.store.updateTurn(turn.id, "aborted");
        await this.#publishUsage(conversation.id);
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: "aborted",
        });
      } else {
        await this.store.updateTurn(turn.id, "failed");
        await this.#publishUsage(conversation.id);
        this.#emitKernel({
          type: "turn.status",
          conversationId: conversation.id,
          turnId: turn.id,
          status: "failed",
          error: formatError(error),
        });
      }
    } finally {
      runtime.pendingWorkspace = undefined;
      runtime.currentTurnId = undefined;
      runtime.controller = undefined;
    }
  }

  async #notifyInput(
    runtime: Runtime,
    conversation: Conversation,
    turnId: TurnId,
    input: DeliveryInput,
    item: Item,
    signal: AbortSignal,
  ): Promise<void> {
    for (const provider of this.host.services.values()) {
      if (signal.aborted) return;
      if (!provider.onInput) continue;
      await provider.onInput(this.#service(runtime, provider.key), {
        conversation,
        rootConversationId: this.#rootOf(conversation.id),
        input,
        item,
        signal,
        model: (backgroundSignal) => this.#modelInvoker(conversation, turnId, backgroundSignal),
        updateTitle: async (title, expected) => {
          await this.#updateTitle(runtime, title, expected);
        },
      });
    }
  }

  async #updateTitle(runtime: Runtime, title: string, expected: string | null): Promise<boolean> {
    if (!(await this.store.updateConversationTitle(runtime.conversation.id, title, expected)))
      return false;
    runtime.setConversation({ ...runtime.conversation, title });
    this.#emitKernel({ type: "title.changed", conversationId: runtime.conversation.id, title });
    return true;
  }

  /** Publish before the terminal event, so an attachment during this await observes completion. */
  async #publishUsage(conversationId: ConversationId): Promise<void> {
    this.#emitKernel({
      type: "usage.changed",
      conversationId,
      summary: await this.store.summarizeModelUsage(conversationId),
    });
  }

  /**
   * The tool-shaped step loop, two phases per step:
   * 1. Consume finalized provider outputs, writing immutable items in emission order.
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
    // Model config is fixed for the whole turn, so its tool set and schemas are resolved once
    // here rather than per step.
    const provider = this.host.providers.get(conversation.config.model.provider);
    provider.validateConfig(conversation.config.model);
    let toolSet = await this.#resolveTools(conversation, runtime);
    let toolSchemas = modelSchemas(toolSet, conversation.config.tools?.mode ?? "hybrid");
    const pricing = this.#pricingFor(conversation.config.model);
    let recoveredOverflow = false;
    let compactedBeforeAttempt = false;
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      const draft = await this.#assembleContext(conversation, toolSchemas, runtime, toolSet);
      if (provider.providerOptions !== undefined) draft.providerOptions = provider.providerOptions;
      const capacity = await this.#contextCapacity(conversation, draft);
      if (capacity.shouldCompact && !compactedBeforeAttempt) {
        const folded = await this.#compact(
          "threshold",
          conversation,
          turnId,
          signal,
          runtime,
          toolSet,
          draft,
          capacity.compactionOutputLimit,
        );
        if (folded) {
          compactedBeforeAttempt = true;
          continue;
        }
      }
      const build = await this.store.recordContextBuild(draft);
      const request: ModelRequest = {
        instructions: build.instructions,
        items: build.items,
        tools: build.tools,
        modelConfig: conversation.config.model,
        ...(build.providerOptions !== undefined ? { providerOptions: build.providerOptions } : {}),
      };

      let evidenceId: string | undefined;
      const evidenceByEvent = new WeakMap<ModelStreamEvent, string>();
      const calls: ToolCall[] = [];
      let completed: Extract<ModelStreamEvent, { type: "completed" }> | undefined;
      let sawOutput = false;
      const preview = new ModelPreview();
      const savePartial = async (): Promise<void> => {
        const partial = preview.takePartial();
        if (partial) await this.#appendOutputItem(partial, conversation, turnId, evidenceId);
      };

      // --- Consume phase: assistant content, in emission order. ---
      const requestStarted = performance.now();
      let requestDurationMs: number | undefined;
      const recordUsage = async (): Promise<void> => {
        const usage = completed?.usage ?? null;
        await this.store.recordModelUsage({
          conversationId: conversation.id,
          turnId,
          contextBuildId: build.id,
          provider: conversation.config.model.provider,
          model: conversation.config.model.model,
          purpose: "agent",
          requestDurationMs: requestDurationMs ?? performance.now() - requestStarted,
          usage,
          cost: pricing && usage ? costOf(usage, pricing) : null,
          ...(completed?.inputTokensAreContext === false ? { inputTokensAreContext: false } : {}),
          ...(completed?.providerUsage !== undefined
            ? { providerUsage: completed.providerUsage }
            : {}),
          ...(completed?.costIncomplete ? { costIncomplete: true } : {}),
        });
        await this.#publishUsage(conversation.id);
      };
      try {
        const stream = this.#streamModel(
          conversation.id,
          request,
          signal,
          provider,
          toolSet,
          evidenceByEvent,
        );
        for await (const event of stream) {
          evidenceId = evidenceByEvent.get(event);
          if (completed)
            throw new Error("provider emitted an event after completed", {
              cause: completed.error,
            });
          if (
            signal.aborted &&
            (event.type === "text_delta" ||
              event.type === "reasoning_delta" ||
              event.type === "provider_output")
          )
            continue;
          preview.accept(event);
          switch (event.type) {
            case "text_delta":
              sawOutput = true;
              this.#emitKernel({
                type: "text_delta",
                conversationId: conversation.id,
                turnId,
                text: event.text,
                ...(event.phase !== undefined ? { phase: event.phase } : {}),
              });
              break;
            case "reasoning_delta":
              sawOutput = true;
              this.#emitKernel({
                type: "reasoning_delta",
                conversationId: conversation.id,
                turnId,
                text: event.text,
              });
              break;
            case "message":
            case "reasoning": {
              sawOutput = true;
              await this.#appendOutputItem(event, conversation, turnId, evidenceId);
              break;
            }
            case "provider_output":
              await this.#appendOutputItem(event, conversation, turnId, evidenceId);
              break;
            case "tool_call": {
              sawOutput = true;
              const call = await this.#appendOutputItem(event, conversation, turnId, evidenceId);
              if (call) calls.push(call);
              break;
            }
            case "completed":
              completed = event;
              requestDurationMs = performance.now() - requestStarted;
              break;
            default:
              assertNever(event);
          }
        }
        if (completed && !completed.error && !signal.aborted) preview.assertFinalized();
      } catch (error) {
        requestDurationMs ??= performance.now() - requestStarted;
        await savePartial();
        await recordUsage();
        await this.#dispatchCalls(
          calls,
          toolSet,
          conversation,
          turnId,
          signal,
          runtime,
          "provider request failed",
        );
        if (
          error instanceof ContextWindowExceededError &&
          !sawOutput &&
          !recoveredOverflow &&
          !compactedBeforeAttempt
        ) {
          recoveredOverflow = true;
          const folded = await this.#compact(
            "overflow",
            conversation,
            turnId,
            signal,
            runtime,
            toolSet,
            draft,
            capacity.compactionOutputLimit,
          );
          if (folded) {
            compactedBeforeAttempt = true;
            continue;
          }
        }
        if (error instanceof ContextWindowExceededError && compactedBeforeAttempt) {
          throw new ContextWindowExceededError(
            "context still exceeds the model window after compaction",
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      requestDurationMs ??= performance.now() - requestStarted;
      await savePartial();
      await recordUsage();

      if (!completed) {
        await this.#dispatchCalls(
          calls,
          toolSet,
          conversation,
          turnId,
          signal,
          runtime,
          "provider stream ended without a 'completed' event",
        );
        if (signal.aborted) throw new TurnAborted();
        throw new Error("provider stream ended without a 'completed' event");
      }
      if (completed.error) {
        await this.#dispatchCalls(
          calls,
          toolSet,
          conversation,
          turnId,
          signal,
          runtime,
          completed.error,
        );
        if (signal.aborted) throw new TurnAborted();
        throw new Error(completed.error);
      }

      // --- Dispatch phase: one tool_result per recorded call, always. ---
      await this.#dispatchCalls(calls, toolSet, conversation, turnId, signal, runtime);

      // --- Finalize. ---
      if (signal.aborted) {
        runtime.pendingWorkspace = undefined;
        throw new TurnAborted();
      }
      if (runtime.pendingWorkspace) {
        const target = runtime.pendingWorkspace;
        runtime.pendingWorkspace = undefined;
        let text: string;
        const oldRoot = conversation.workspaceRoot;
        try {
          await this.#replaceWorkspace(runtime, target);
          text = `Working directory switched from ${oldRoot} to ${target}. No files moved. Earlier relative output paths belong to ${oldRoot}; do not resolve them against the new checkout.`;
        } catch (error) {
          text = `Workspace switch failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (runtime.conversation.workspaceRoot !== oldRoot) {
          conversation = {
            ...conversation,
            workspaceRoot: runtime.conversation.workspaceRoot,
            originalWorkspaceRoot: runtime.conversation.originalWorkspaceRoot!,
          };
          toolSet = await this.#resolveTools(conversation, runtime);
          toolSchemas = modelSchemas(toolSet, conversation.config.tools?.mode ?? "hybrid");
        }
        const item = await this.store.appendItem({
          conversationId: conversation.id,
          turnId,
          type: "context",
          key: "workspace-switch",
          content: [{ type: "text", text }],
        });
        this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
      }
      if (calls.length === 0) {
        return; // final, non-tool response: the turn is done
      }
      compactedBeforeAttempt = false;

      // After-tool-result boundary: only steers flush into this turn; queued
      // entries wait for the next batch.
      await this.#flushSteers(runtime, conversation, turnId, signal);
    }

    throw new Error(`turn exceeded ${MAX_MODEL_STEPS} model steps`);
  }

  /** Persists one finalized structured model output and returns its executable call, if any. */
  async #appendOutputItem(
    output: ModelOutputItem,
    conversation: Conversation,
    turnId: TurnId,
    evidenceId?: string,
  ): Promise<ToolCall | undefined> {
    if (output.type !== "tool_call") {
      const base = {
        conversationId: conversation.id,
        turnId,
        content: output.content,
      };
      const item = await this.store.appendItem(
        output.type === "message"
          ? {
              ...base,
              type: "message",
              role: "assistant",
              ...(output.phase !== undefined ? { phase: output.phase } : {}),
            }
          : { ...base, type: output.type },
      );
      if (evidenceId)
        await this.store.putPluginState("model-evidence", conversation.id, `item:${item.id}`, {
          attemptId: evidenceId,
        });
      if (output.payload)
        await this.store.putProviderPayload({ ...output.payload, itemId: item.id });
      this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
      return undefined;
    }
    const item = await this.store.appendItem({
      conversationId: conversation.id,
      turnId,
      type: "tool_call",
      callId: output.callId,
      name: output.name,
      args: output.args,
    });
    if (evidenceId)
      await this.store.putPluginState("model-evidence", conversation.id, `item:${item.id}`, {
        attemptId: evidenceId,
      });
    if (output.payload) await this.store.putProviderPayload({ ...output.payload, itemId: item.id });
    this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
    return { callId: output.callId, name: output.name, args: output.args };
  }

  /** Pairs every persisted call with exactly one result through the common dispatch path. */
  async #dispatchCalls(
    calls: ToolCall[],
    toolSet: ToolSet,
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    terminalError?: string,
  ): Promise<void> {
    const batchContexts: PendingContext[] = [];
    for (const call of calls) {
      await this.#invokeRecorded(
        call,
        toolSet,
        conversation,
        turnId,
        signal,
        runtime,
        batchContexts,
        terminalError,
      );
    }
    for (const pending of batchContexts) {
      const item = await this.store.appendItem({
        conversationId: conversation.id,
        turnId,
        type: "context",
        key: pending.key,
        content: pending.content,
      });
      this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
    }
  }

  /**
   * Record a child's call before dispatch, and every call's result before returning it.
   * parentCallId links a child to its invoking eval; it does not change the log's branch parent.
   * Model-origin calls were already recorded while consuming the provider stream.
   */
  async #invokeRecorded(
    call: ToolCall,
    toolSet: ToolSet,
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    batchContexts: PendingContext[],
    terminalError?: string,
  ): Promise<ToolResult> {
    if (call.parentCallId) {
      const item = await this.store.appendItem({
        conversationId: conversation.id,
        turnId,
        type: "tool_call",
        ...call,
      });
      this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
    }
    const callContexts: PendingContext[] = [];
    const mode = conversation.config.tools?.mode ?? "hybrid";
    const available = call.parentCallId
      ? toolSet.exposes(call.name, "code")
      : allowsDirect(toolSet, call.name, mode);
    const outcome = signal.aborted
      ? { result: interruptedResult(), completed: false }
      : terminalError
        ? { result: errorResult(terminalError), completed: false }
        : !available
          ? {
              result: errorResult(
                toolSet.has(call.name)
                  ? `tool unavailable through ${call.parentCallId ? "code" : "model"} interface: ${call.name}`
                  : `unknown tool: ${call.name}`,
              ),
              completed: false,
            }
          : await this.#dispatchInterruptible(
              call,
              toolSet,
              conversation,
              turnId,
              signal,
              runtime,
              callContexts,
            );
    const { result } = outcome;
    const structured =
      result.structured === undefined ? undefined : JSON.stringify(result.structured);
    const structuredRef =
      structured && Buffer.byteLength(structured) > 64 * 1024
        ? await this.store.putBlob(Buffer.from(structured))
        : undefined;
    const item = await this.store.appendItem({
      conversationId: conversation.id,
      turnId,
      type: "tool_result",
      callId: call.callId,
      ...(call.parentCallId ? { parentCallId: call.parentCallId } : {}),
      content: result.forModel,
      status: result.status,
      ...(result.annotations ? { annotations: result.annotations } : {}),
      ...(structuredRef
        ? { structuredRef }
        : result.structured === undefined
          ? {}
          : { structured: result.structured }),
      ...(result.full ? { full: result.full } : {}),
    });
    this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item });
    if (outcome.completed) {
      for (const pending of callContexts) {
        if (!batchContexts.some(({ key }) => key === pending.key)) batchContexts.push(pending);
      }
    }
    return result;
  }

  /** Injects only steering deliveries at a tool-result boundary. */
  async #flushSteers(
    runtime: Runtime,
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
  ): Promise<void> {
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
      this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item: message });
      await this.#notifyInput(runtime, conversation, turnId, steer.input, message, signal);
    }
  }

  /**
   * Races dispatch against abort: if abort wins, the call gets a synthetic
   * `interrupted` result and the tool is abandoned (cooperative tools also stop via
   * `ctx.signal`). Either way the call gets exactly one result.
   */
  async #dispatchInterruptible(
    call: ToolCall,
    toolSet: ToolSet,
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    pendingContexts: PendingContext[],
  ): Promise<DispatchOutcome> {
    const controller = new AbortController();
    const callSignal = AbortSignal.any([signal, controller.signal]);
    const children: Promise<ToolResult>[] = [];
    const modelInvocations: Promise<ModelInvocationResult>[] = [];
    const annotations: Record<string, unknown> = {};
    const finalize = (result: ToolResult): ToolResult =>
      Object.keys(annotations).length === 0
        ? result
        : {
            ...result,
            annotations: { ...result.annotations, ...annotations },
          };
    if (signal.aborted) {
      return { result: finalize(interruptedResult()), completed: false };
    }
    let onAbort!: () => void;
    const aborted = new Promise<DispatchOutcome>((resolve) => {
      onAbort = () => resolve({ result: finalize(interruptedResult()), completed: false });
      callSignal.addEventListener("abort", onAbort, { once: true });
    });
    const dispatched = this.#dispatch(
      call,
      toolSet,
      conversation,
      turnId,
      callSignal,
      runtime,
      annotations,
      pendingContexts,
      children,
      modelInvocations,
    ).then((result) => ({ result: finalize(result), completed: true }));
    try {
      // Evaluator cancellation must terminate its worker and preserve emitted content.
      return await (call.name === EVALUATOR_NAME
        ? dispatched
        : Promise.race([dispatched, aborted]));
    } finally {
      callSignal.removeEventListener("abort", onAbort);
      controller.abort();
      // Recorded descendants must be paired before the outer result/turn can finish.
      // Accounting started by a model-backed approval belongs to this turn even when
      // the outer tool is abandoned. Settle it before terminal publication/teardown.
      await Promise.allSettled(modelInvocations);
      await Promise.all(children);
    }
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
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    resultAnnotations: Record<string, unknown>,
    pendingContexts: PendingContext[],
    children: Promise<ToolResult>[],
    modelInvocations: Promise<ModelInvocationResult>[],
  ): Promise<ToolResult> {
    type ParsedCall = ReturnType<typeof parseToolArgs> | undefined;
    const parsedCalls = new Map<ToolCall, ParsedCall>();
    const parseCall = (candidate: ToolCall): ParsedCall => {
      if (parsedCalls.has(candidate)) return parsedCalls.get(candidate);
      const parsed = toolSet.has(candidate.name)
        ? parseToolArgs(toolSet.get(candidate.name), candidate.args)
        : undefined;
      parsedCalls.set(candidate, parsed);
      return parsed;
    };
    const ctx: ToolMiddlewareContext = {
      conversationId: conversation.id,
      callId: call.callId,
      signal,
      toolMeta: (name) => toolSet.metaOf(name),
      toolContract: (name) => toolSet.contract(name),
      ...(call.name === EVALUATOR_NAME
        ? {
            codeTools: {
              call: (name: string, args: unknown) => {
                signal.throwIfAborted();
                const child = this.#invokeRecorded(
                  { callId: `nested_${randomUUID()}`, name, args, parentCallId: call.callId },
                  toolSet,
                  conversation,
                  turnId,
                  signal,
                  runtime,
                  pendingContexts,
                );
                children.push(child);
                return child;
              },
            },
          }
        : {}),
      acceptsToolCall: (candidate) => parseCall(candidate)?.ok === true,
      setResultAnnotation: (key, value) => {
        resultAnnotations[key] = value;
      },
      service: (key) => this.#service(runtime, key),
      // Default the dispatching conversation onto the event so a plugin can't emit an
      // unscoped (and thus silently dropped) event; an explicit id in the event still wins.
      emit: (event) => {
        if (
          this.#runtimes.get(conversation.id) === runtime &&
          !this.#rootScopeUnavailable(conversation.id)
        ) {
          this.#emitPlugin({ conversationId: conversation.id, ...event });
        }
      },
      // Plugin-origin delivery, fixed to `steer`, stamped with the dispatching tool's name.
      deliver: (content) => {
        // Completion callbacks belong to this activation. Addressing only the durable id would
        // let a disposed plugin inject work into a replacement runtime after reload.
        if (
          this.#runtimes.get(conversation.id) !== runtime ||
          this.#rootScopeUnavailable(conversation.id)
        )
          return;
        applyDelivery(runtime, {
          input: { source: { kind: "plugin", pluginId: call.name }, content },
          intent: "steer",
        });
        this.#emitInbox(runtime);
        this.#ensureRunning(runtime);
      },
      putBlob: (bytes) => this.store.putBlob(bytes),
      request: (request, options) =>
        this.#request(request, conversation, turnId, signal, runtime, modelInvocations, options),
      active: async () => compactedWindow(await this.store.listActiveItems(conversation.id)),
      appendContext: async (key, content) => {
        if (signal.aborted) throw new Error("interrupted: turn aborted");
        if (pendingContexts.some((pending) => pending.key === key)) return;
        pendingContexts.push({ key, content });
      },
    };
    const execute: ToolHandler = (c) => {
      signal.throwIfAborted();
      const parsed = parseCall(c);
      if (!parsed) return Promise.resolve(errorResult(`unknown tool: ${c.name}`));
      const tool = toolSet.get(c.name);
      if (!parsed.ok) return Promise.resolve(parsed.result);
      return tool.execute(parsed.data, ctx);
    };
    try {
      // Reserved discovery reads host metadata only. Its own bounded output must not be cropped
      // by execution middleware while retaining annotations that say definitions were delivered.
      return await (isDiscoveryTool(call.name)
        ? execute(call)
        : runToolChain(this.host.toolMiddleware, call, ctx, execute));
    } catch (error) {
      return errorResult(`tool '${call.name}' failed: ${formatError(error)}`);
    }
  }

  /**
   * Host side of `ctx.request`: parks on a new request id until `respond` resolves it.
   * Abort-aware — on abort the entry is removed and the promise rejects, so nothing leaks.
   */
  #request(
    request: InteractionRequest,
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    modelInvocations: Promise<ModelInvocationResult>[],
    options?: RequestOptions,
  ): Promise<unknown> {
    if (
      this.#runtimes.get(conversation.id) !== runtime ||
      this.#rootScopeUnavailable(conversation.id)
    ) {
      return Promise.reject(new Error("cannot request interaction from an inactive runtime"));
    }
    const ctx: RequestMiddlewareContext = {
      conversation,
      turnId,
      signal,
      active: async (options) => {
        const items = await this.store.listActiveItems(conversation.id);
        return options?.includeCompacted ? items : compactedWindow(items);
      },
      instructions: async () => [
        { type: "text", text: conversation.config.instructions },
        ...(
          await Promise.all(
            this.host.contextSources.map((source) =>
              source.instructions({ service: (key) => this.#service(runtime, key), toolNames: [] }),
            ),
          )
        ).flat(),
      ],
      readBlob: (
        ref: import("@harness/protocol").OutputRef,
        range: import("@harness/protocol").ByteRange,
      ) => this.store.getBlob(ref, range),
      service: (key: string) => this.#service(runtime, key),
      emit: (event: PluginEvent) => {
        if (
          this.#runtimes.get(conversation.id) === runtime &&
          !this.#rootScopeUnavailable(conversation.id)
        ) {
          this.#emitPlugin({ conversationId: conversation.id, ...event });
        }
      },
      models: this.#modelInvoker(conversation, turnId, signal, undefined, modelInvocations),
    };
    return runRequestChain(this.host.requestMiddleware, request, ctx, (req) =>
      this.#parkRequest(req, conversation.id, signal, runtime, options),
    );
  }

  /**
   * The terminal request transport: emit, park, and resolve through `respond`.
   * Request middleware that short-circuits never reaches this method and emits no UI events.
   */
  #parkRequest(
    request: InteractionRequest,
    conversationId: ConversationId,
    signal: AbortSignal,
    runtime: Runtime,
    options?: RequestOptions,
  ): Promise<unknown> {
    const aborted = (): Error => new Error("interrupted: turn aborted");
    if (
      this.#runtimes.get(conversationId) !== runtime ||
      this.#rootScopeUnavailable(conversationId)
    ) {
      return Promise.reject(new Error("cannot request interaction from an inactive runtime"));
    }
    if (signal.aborted) return Promise.reject(aborted());
    const requestId = `req_${++this.#requestSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        runtime.pendingRequests.delete(requestId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        this.#emitKernel({ type: "request.resolved", requestId, conversationId });
        reject(aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      runtime.pendingRequests.set(requestId, {
        request,
        resolve: (response) => {
          cleanup();
          this.#emitKernel({ type: "request.resolved", requestId, conversationId });
          resolve(response);
        },
      });
      if (options?.timeoutMs !== undefined) {
        if (
          !Number.isFinite(options.timeoutMs) ||
          options.timeoutMs <= 0 ||
          options.timeoutMs > 2_147_483_647
        ) {
          cleanup();
          reject(new RangeError("invalid interaction timeout"));
          return;
        }
        timer = setTimeout(() => {
          cleanup();
          this.#emitKernel({ type: "request.resolved", requestId, conversationId });
          reject(new InteractionTimeoutError());
        }, options.timeoutMs);
      }
      this.#emitKernel({ type: "request.created", requestId, conversationId, request });
    });
  }

  /** The single middleware-to-provider stream boundary for every model-backed operation. */
  #streamModel(
    conversationId: ConversationId,
    request: ModelRequest,
    signal: AbortSignal,
    provider: ModelProvider,
    toolSet?: ToolSet,
    evidenceByEvent?: WeakMap<ModelStreamEvent, string>,
  ): AsyncIterable<ModelStreamEvent> {
    const store = this.store;
    const context: ModelCallContext = { conversationId };
    const captureScope = new AsyncLocalStorage<((body: JsonValue) => Promise<void>) | undefined>();
    if (evidenceByEvent)
      context.captureRequest = async (body) => {
        const capture = captureScope.getStore();
        if (!capture) throw new Error("Native request capture has no invocation scope");
        await capture(body);
      };
    return runModelChain(
      this.host.modelMiddleware,
      request,
      {
        conversationId,
        signal,
        toolMeta: (name) => toolSet?.metaOf(name),
      },
      async function* (nextRequest) {
        let attemptId: string | undefined;
        let capture: ((body: JsonValue) => Promise<void>) | undefined;
        if (evidenceByEvent) {
          attemptId = randomUUID();
          const capturedId = attemptId;
          const trace = {
            request: nextRequest,
            nativeRequest: null as JsonValue | null,
            limitation:
              "Native body not exposed by this adapter; canonical effective request recorded.",
          };
          await store.putPluginState("model-evidence", conversationId, capturedId, trace);
          capture = async (body) => {
            trace.nativeRequest = body;
            trace.limitation =
              "Provider-side token rendering is not inspectable; native request body recorded.";
            await store.putPluginState("model-evidence", conversationId, capturedId, trace);
          };
        }
        try {
          const iterator = provider.stream(nextRequest, signal, context)[Symbol.asyncIterator]();
          try {
            for (;;) {
              const result = await captureScope.run(capture, () => iterator.next());
              if (result.done) break;
              if (attemptId) evidenceByEvent!.set(result.value, attemptId);
              yield result.value;
            }
          } finally {
            if (iterator.return) await captureScope.run(capture, () => iterator.return!());
          }
        } catch (error) {
          // Preserve context-limit recovery; classify other provider failures at their boundary.
          if (error instanceof ContextWindowExceededError) throw error;
          throw new ModelInvocationFailure(
            error instanceof Error ? "model provider failed" : String(error),
            { cause: error },
          );
        }
      },
    );
  }

  /** Builds a one-provider-call model capability scoped to this turn. */
  #modelInvoker(
    conversation: Conversation,
    turnId: TurnId,
    turnSignal: AbortSignal,
    modelMiddlewareTools?: ToolSet,
    pending?: Promise<ModelInvocationResult>[],
  ): ModelInvoker {
    const invoke: ModelInvoker["invoke"] = async (draft, options = {}) => {
      if (turnSignal.aborted) throw new ModelInvocationFailure("model invocation aborted");
      const modelConfig = draft.modelConfig ?? conversation.config.model;
      const provider = this.host.providers.get(modelConfig.provider);
      provider.validateConfig(modelConfig);
      const signal = options.signal ? AbortSignal.any([turnSignal, options.signal]) : turnSignal;
      const request: ModelRequest = {
        instructions: draft.instructions,
        items: draft.items.filter(({ item }) => item.type !== "provider_output"),
        modelConfig,
        ...(draft.tools ? { tools: draft.tools } : {}),
        ...(draft.prompt ? { prompt: draft.prompt } : {}),
        ...(draft.toolChoice ? { toolChoice: draft.toolChoice } : {}),
        ...(draft.maxOutputTokens !== undefined ? { maxOutputTokens: draft.maxOutputTokens } : {}),
        ...(provider.providerOptions !== undefined
          ? { providerOptions: provider.providerOptions }
          : {}),
      };
      const build =
        options.persistContext === false
          ? undefined
          : await this.store.recordContextBuild({
              conversationId: conversation.id,
              purpose: options.purpose ?? "plugin",
              instructions: request.instructions,
              tools: request.tools ?? [],
              items: request.items,
              ...(request.prompt ? { prompt: request.prompt } : {}),
              ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
              ...(request.maxOutputTokens !== undefined
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
              ...(request.providerOptions !== undefined
                ? { providerOptions: request.providerOptions }
                : {}),
            });
      if (signal.aborted) throw new ModelInvocationFailure("model invocation aborted");
      const outputItems: ModelOutputItem[] = [];
      const preview = new ModelPreview();
      const requestStarted = performance.now();
      let completed: Extract<ModelStreamEvent, { type: "completed" }> | undefined;
      let requestDurationMs: number | undefined;
      const pricing = this.#pricingFor(modelConfig);
      const recordUsage = async (): Promise<void> => {
        const usage = completed?.usage ?? null;
        await this.store.recordModelUsage({
          conversationId: conversation.id,
          turnId,
          contextBuildId: build?.id ?? null,
          provider: modelConfig.provider,
          model: modelConfig.model,
          purpose: options.purpose ?? "plugin",
          requestDurationMs: requestDurationMs ?? performance.now() - requestStarted,
          usage,
          cost: pricing && usage ? costOf(usage, pricing) : null,
          ...(completed?.inputTokensAreContext === false ? { inputTokensAreContext: false } : {}),
          ...(completed?.providerUsage !== undefined
            ? { providerUsage: completed.providerUsage }
            : {}),
          ...(completed?.costIncomplete ? { costIncomplete: true } : {}),
        });
        await this.#publishUsage(conversation.id);
      };
      try {
        const stream = this.#streamModel(
          conversation.id,
          request,
          signal,
          provider,
          modelMiddlewareTools,
        );
        for await (const event of stream) {
          if (completed)
            throw new Error("provider emitted an event after completed", {
              cause: completed.error,
            });
          if (
            signal.aborted &&
            (event.type === "text_delta" ||
              event.type === "reasoning_delta" ||
              event.type === "provider_output")
          )
            continue;
          preview.accept(event);
          if (event.type === "completed") {
            completed = event;
            requestDurationMs = performance.now() - requestStarted;
          } else if (event.type !== "text_delta" && event.type !== "reasoning_delta") {
            outputItems.push(event);
          }
        }
        if (completed && !completed.error && !signal.aborted) preview.assertFinalized();
      } catch (error) {
        requestDurationMs ??= performance.now() - requestStarted;
        await recordUsage();
        if (signal.aborted) throw new ModelInvocationFailure("model invocation aborted");
        throw error;
      }
      if (!completed) {
        requestDurationMs ??= performance.now() - requestStarted;
        await recordUsage();
        if (signal.aborted) throw new ModelInvocationFailure("model invocation aborted");
        throw new Error("provider stream ended without a 'completed' event");
      }
      await recordUsage();
      if (signal.aborted) throw new ModelInvocationFailure("model invocation aborted");
      if (completed.error) throw new ModelInvocationFailure(completed.error);
      return {
        content: outputItems.flatMap((item) => (item.type === "message" ? item.content : [])),
        outputItems,
        usage: completed.usage,
        modelConfig,
      };
    };
    return {
      invoke: (draft, options) => {
        const invocation = invoke(draft, options);
        pending?.push(invocation);
        return invocation;
      },
    };
  }

  /** Capacity policy derived from the best provider checkpoint plus appended local estimates. */
  async #contextCapacity(
    conversation: Conversation,
    build: NewContextBuild,
  ): Promise<{ shouldCompact: boolean; compactionOutputLimit?: number }> {
    const info = findModel(this.host.providers.listModels(), conversation.config.model);
    const output = info?.maxOutputTokens;
    const contextInput =
      info?.contextWindow !== undefined && output !== undefined
        ? info.contextWindow - output
        : undefined;
    const input =
      info?.maxInputTokens === undefined
        ? contextInput
        : Math.min(info.maxInputTokens, contextInput ?? Infinity);
    const headroom = input === undefined ? 0 : Math.ceil(input * 0.02);
    // The next answer must also fit as input when the following request compacts it.
    const automatic =
      input !== undefined && output !== undefined
        ? Math.max(0, input - output - headroom)
        : undefined;
    const threshold = Math.min(
      conversation.config.compaction?.thresholdTokens ?? Infinity,
      automatic ?? Infinity,
    );
    if (!Number.isFinite(threshold) && (info?.contextWindow === undefined || output === undefined))
      return { shouldCompact: false };

    let estimate: number | undefined;
    const usage = await this.store.listModelUsage(conversation.id);
    for (let i = usage.length - 1; i >= 0; i--) {
      const row = usage[i]!;
      if (!row.usage || row.inputTokensAreContext === false) continue;
      if (
        row.provider !== conversation.config.model.provider ||
        row.model !== conversation.config.model.model ||
        !row.contextBuildId
      ) {
        continue;
      }
      const prior = await this.store.getContextBuild(row.contextBuildId);
      if (!prior || prior.purpose !== "agent" || prior.items.length > build.items.length) continue;
      const samePrefix = prior.items.every(
        (entry, index) => entry.item.id === build.items[index]?.item.id,
      );
      const sameStableInput =
        JSON.stringify(prior.instructions) === JSON.stringify(build.instructions) &&
        JSON.stringify(prior.tools) === JSON.stringify(build.tools) &&
        JSON.stringify(prior.providerOptions) === JSON.stringify(build.providerOptions);
      if (!samePrefix || !sameStableInput) continue;
      estimate =
        row.usage.inputTokens +
        estimateContextTokens({
          conversationId: build.conversationId,
          purpose: "estimate",
          instructions: [],
          tools: [],
          items: build.items.slice(prior.items.length),
        });
      break;
    }
    estimate ??= estimateContextTokens(build);
    return {
      shouldCompact: estimate >= threshold,
      ...(output === undefined || info?.contextWindow === undefined
        ? {}
        : {
            compactionOutputLimit: Math.max(
              0,
              Math.min(output, info.contextWindow - estimate - headroom),
            ),
          }),
    };
  }

  /** Materializes a strategy result, then continues any reasoning/tool calls through normal paths. */
  async #compact(
    reason: "threshold" | "overflow" | "manual",
    conversation: Conversation,
    turnId: TurnId,
    signal: AbortSignal,
    runtime: Runtime,
    toolSet: ToolSet,
    build: NewContextBuild,
    outputTokenLimit?: number,
  ): Promise<boolean> {
    if (signal.aborted) throw new TurnAborted();
    if (build.items.length === 0) return false;
    let result;
    try {
      result = await this.host.policies.compaction.compact({
        reason,
        build,
        models: this.#modelInvoker(conversation, turnId, signal, toolSet),
        ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
        signal,
      });
      if (signal.aborted) throw new TurnAborted();
      if (!result) return false;
      if (textOf(result.content).trim().length === 0) {
        const toolCalls =
          result.outputItems?.filter((item) => item.type === "tool_call").length ?? 0;
        throw new Error(
          `compaction strategy returned no summary (empty text; ${toolCalls} tool calls)`,
        );
      }
      if (
        reason === "manual" &&
        result.outputItems?.some((output) => output.type === "tool_call")
      ) {
        throw new Error("manual compaction cannot emit tool calls");
      }
    } catch (error) {
      if (signal.aborted) throw new TurnAborted();
      if (reason === "manual" || !(error instanceof ContextWindowExceededError)) throw error;
      result = { content: fallbackCompaction(build) };
    }

    if (signal.aborted) throw new TurnAborted();

    const fold = await this.store.appendItem({
      conversationId: conversation.id,
      turnId,
      type: "compaction",
      content: result.content,
    });
    this.#emitKernel({ type: "item.appended", conversationId: conversation.id, item: fold });

    // Reasoning generated only to produce a summary is not task continuation. Keep
    // structured output only when the compactor actually asked to continue with a tool.
    const outputs = result.outputItems ?? [];
    const continuation = outputs.some((output) => output.type === "tool_call") ? outputs : [];
    const calls: ToolCall[] = [];
    for (const output of continuation) {
      const call = await this.#appendOutputItem(output, conversation, turnId);
      if (call) calls.push(call);
    }
    await this.#dispatchCalls(calls, toolSet, conversation, turnId, signal, runtime);
    if (calls.length > 0) {
      await this.#flushSteers(runtime, conversation, turnId, signal);
    }
    if (signal.aborted) throw new TurnAborted();
    return true;
  }

  async #resolveTools(conversation: Conversation, runtime: Runtime): Promise<ToolSet> {
    const provider = this.host.providers.get(conversation.config.model.provider);
    const tools = this.host.toolsFor(
      provider.capabilities(conversation.config.model.model),
      { service: (key) => this.#service(runtime, key) },
      conversation.config.tools?.allow,
    );
    for (const name of [EVALUATOR_NAME, "tool_search", "tool_describe"])
      if (tools.has(name)) throw new Error(`reserved core tool name: ${name}`);
    const catalog = await this.host.resolveContracts(tools, {
      conversationId: conversation.id,
      toolMeta: (name) => tools.metaOf(name),
    });
    const mode = conversation.config.tools?.mode ?? "hybrid";
    const upfront = mode === "code-only" ? upfrontTools(catalog) : [];
    const controls = discoveryTools(
      catalog,
      [
        ...modelSchemas(catalog, mode).map((schema) => schema.name),
        ...upfront.map((tool) => tool.input.name),
      ],
      async () => compactedWindow(await this.store.listActiveItems(conversation.id)),
    );
    controls.push(evaluatorTool(this.codeEvaluator, upfront));
    return new ToolSet(
      [...catalog.values(), ...controls],
      catalog.schemas().map((schema) => catalog.contract(schema.name)!),
    );
  }

  /** The model's rate card from its provider's catalog; undefined = cost not computable. */
  #pricingFor(model: ModelConfig): ModelPricing | undefined {
    return findModel(this.host.providers.listModels(), model)?.pricing;
  }

  async #assembleContext(
    conversation: Conversation,
    tools: ToolSchema[],
    runtime: Runtime,
    scopedTools: ToolSet,
  ): Promise<NewContextBuild> {
    // Use the active chain (not the raw log): after a rewind, abandoned-branch items
    // must stay out of context. Read `head` from the store, never off the cached
    // `Runtime.conversation` snapshot.
    const items = compactedWindow(await this.store.listActiveItems(conversation.id))
      .filter(
        (item) =>
          item.type !== "provider_output" &&
          !((item.type === "tool_call" || item.type === "tool_result") && item.parentCallId),
      )
      .map((item) => {
        if (item.type !== "tool_result") return item;
        const presentation = { ...item };
        delete presentation.structured;
        delete presentation.structuredRef;
        delete presentation.full;
        return presentation;
      });
    const payloadList = await this.store.getProviderPayloads(items.map((i) => i.id));
    const payloads = new Map(payloadList.map((p) => [p.itemId, p]));
    const mode = conversation.config.tools?.mode ?? "hybrid";
    const sourceContext = {
      service: (key: string) => this.#service(runtime, key),
      toolNames: scopedTools
        .schemas()
        .filter(
          (schema) =>
            allowsDirect(scopedTools, schema.name, mode) ||
            scopedTools.exposes(schema.name, "code"),
        )
        .map((schema) => schema.name),
    };
    const sourceInstructions = (
      await Promise.all(
        this.host.contextSources.map((source) => source.instructions(sourceContext)),
      )
    ).flat();
    const instructions: ContentBlock[] = [
      { type: "text", text: conversation.config.instructions },
      { type: "text", text: "Cite sources using Markdown links." },
      ...(conversation.workspaceRoot
        ? [
            {
              type: "text" as const,
              text: `Current working directory: ${conversation.workspaceRoot}. Files and saved outputs are not moved when switching workspaces; use recorded absolute output paths or switch back to the originating workspace.${conversation.originalWorkspaceRoot ? ` Original checkout: ${conversation.originalWorkspaceRoot}. Historical relative .harness output paths from before workspace switching belong to that checkout.` : ""}`,
            },
          ]
        : []),
      ...sourceInstructions,
    ];

    return {
      conversationId: conversation.id,
      purpose: "agent",
      instructions,
      tools,
      items: items.map((item) => {
        const payload = payloads.get(item.id);
        return payload ? { item, payload } : { item };
      }),
    };
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
