import { z, type ZodType } from "zod";
import type { ContentBlock } from "./content.ts";
import type { ConversationId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ToolGrammar } from "./model.ts";
import type { PluginEvent } from "./events.ts";
import type { InteractionRequest, RequestOptions } from "./requests.ts";
import type { JsonValue } from "./rpc.ts";
import type { ToolSchema } from "./model.ts";

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  /** Invoking tool, independent of the item's conversation-branch parent. */
  readonly parentCallId?: string;
}

export type ToolStatus = "ok" | "error";

/** Reference to full raw output in the blob store; never auto-sent to the model. */
export interface OutputRef {
  id: string;
  bytes: number;
  contentType: string;
}

export const outputRefSchema = z.strictObject({
  id: z.string(),
  bytes: z.number().int().nonnegative(),
  contentType: z.string(),
});

export interface ToolResult {
  forModel: ContentBlock[];
  /** JSON data for programmatic consumers, processed by the same tool middleware. */
  structured?: JsonValue;
  full?: OutputRef;
  /** Namespaced, durable facts about how this result was produced. Never sent to a provider. */
  annotations?: Record<string, unknown>;
  status: ToolStatus;
}

/** A single-text-block error result — the conventional shape for a failed or denied call. */
export const errorResult = (text: string): ToolResult => ({
  forModel: [{ type: "text", text }],
  status: "error",
});

/** A single-text-block success result — the `ok` mirror of `errorResult`. */
export const okResult = (text: string): ToolResult => ({
  forModel: [{ type: "text", text }],
  status: "ok",
});

/** Per-call environment handed to a tool. */
export interface ToolContext {
  conversationId: ConversationId;
  /** This call's id (`ToolCall.callId`); lets a tool correlate state it registers for itself. */
  callId: string;
  signal: AbortSignal;
  /** Present only on the core evaluator entry point. Closed when the call ends. */
  codeTools?: CodeToolBridge;
  /**
   * A per-conversation service a plugin hangs off `ctx`, keyed and built lazily by its
   * `ServiceProvider` (e.g. the execution substrate under `"execution"`, or an activity
   * registry under `"activities"`). `undefined` when no plugin owns `key`. Opaque to the
   * kernel — narrow via a typed accessor like `executionOf`/`activitiesOf`.
   */
  service(key: string): unknown;
  /** Emit a plugin-defined event onto the conversation's stream. */
  emit(event: PluginEvent): void;
  /**
   * Deliver plugin-originated content into this conversation as a `steer`: it surfaces at the
   * next after-tool-result boundary of a live turn, or starts a turn when idle. Valid after the
   * call returns (it closes over the conversation, not the turn) — so a backgrounded unit of work
   * can wake the agent long after its spawning tool returned. Stamped with the dispatching tool's
   * name as provenance.
   */
  deliver(content: ContentBlock[]): void;
}

/**
 * What a tool declares about its arguments. `function` is a zod schema; `custom` is a raw
 * string the model emits and `parse`d to `A`. The kernel derives the wire `ToolSchema` from this
 * and validates raw args against it, so `execute` only ever sees a validated `A`.
 */
export type ToolInput<A> =
  | { kind: "function"; schema: ZodType<A> }
  | { kind: "json-schema"; schema: Record<string, unknown>; parse: (raw: unknown) => A }
  | { kind: "custom"; grammar?: ToolGrammar; parse: (raw: string) => A };

export interface Tool<A = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: ToolInput<A>;
  /** Presentation channels, never permissions. Omitted means both channels. */
  readonly exposure?: { direct: boolean; code: boolean };
  /** Basic tools the agent needs without discovery; presentation only, never permissions. */
  readonly essential?: boolean;
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Open, kernel-opaque metadata bag. The kernel only ferries it and exposes a name→meta
   * lookup (`ModelMiddlewareContext.toolMeta`); plugins agree on namespaced keys by convention
   * (cf. `PluginEvent.type`). E.g. the activities plugin reads `meta.backgroundable`.
   */
  readonly meta?: Record<string, unknown>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/** A point in the middleware chain: runs the next inner middleware, or the tool. */
export type ToolHandler = (call: ToolCall) => Promise<ToolResult>;

export interface ToolMiddlewareContext extends ToolContext {
  /**
   * The opaque `meta` bag of an offered tool by name (`undefined` if unknown / none) — the same
   * lookup `ModelMiddlewareContext` exposes, so a result-shaping middleware can read tool metadata
   * (e.g. skip bounding `addressableOutput` tools) without the `Tool` itself.
   */
  toolMeta(name: string): Record<string, unknown> | undefined;
  /** The effective callable contract, including plugin enrichment. */
  toolContract(name: string): ToolContract | undefined;
  /** True only when the call names an offered tool and its raw arguments pass that tool's parser. */
  acceptsToolCall(call: ToolCall): boolean;
  /**
   * Records call-scoped durable metadata that the engine merges into the final
   * result, including synthetic failures and live interruption. Last writer wins
   * for a key; scoped values override annotations returned directly by a tool.
   */
  setResultAnnotation(key: string, value: unknown): void;
  /** Spill bytes the model shouldn't see inline; the returned ref goes on `full`. */
  putBlob(bytes: Uint8Array): Promise<OutputRef>;
  /**
   * Block until the host (or a UI) answers a correlated request. The kernel only
   * ferries the opaque payload by id; the middleware owns the request/response shape
   * (e.g. `{kind:"approval", call}` → `{decision}`). Rejects if the turn is aborted.
   */
  request(request: InteractionRequest, options?: RequestOptions): Promise<unknown>;
  /**
   * The compacted active window, re-derived from the durable log — the same source the model
   * build reads. Context staged by the current call is not visible until its result is persisted.
   */
  active(): Promise<readonly Item[]>;
  /**
   * Stage a durable, keyed `context` item after the current tool-call batch's results
   * (e.g. AGENTS.md).
   * `key` is opaque to the kernel; dedup is the caller's job — scan `active()` first.
   * Logged as a real item, so the injection is rewind-safe without splitting provider-required
   * tool-call/result adjacency.
   */
  appendContext(key: string, content: ContentBlock[]): Promise<void>;
}

/**
 * Wraps a tool call. `next` may be called zero times (deny/short-circuit), once
 * (normal), or many times (retry). Return a `ToolResult` either way — the chain
 * never throws past the engine. Subsumes the old `ToolGate` + `OutputProjection`.
 */
export interface ToolMiddleware {
  readonly id: string;
  wrap(call: ToolCall, ctx: ToolMiddlewareContext, next: ToolHandler): Promise<ToolResult>;
}

export type ToolMode = "direct" | "hybrid" | "code-only";

/** A tool's public description and argument schema, plus its result schema when known. */
export interface ToolContract {
  input: ToolSchema;
  outputSchema?: Record<string, unknown>;
}

export interface ToolContractContext {
  conversationId: ConversationId;
  toolMeta(name: string): Record<string, unknown> | undefined;
}

/** Enrich an effective contract or withhold it. Identity and exposure stay host-owned. */
export type ToolContractResolver = (
  contract: ToolContract,
  ctx: ToolContractContext,
) => ToolContract | null | Promise<ToolContract | null>;

/** Core owns scope and recording; the evaluator owns only JavaScript execution. */
export interface CodeToolBridge {
  call(name: string, args: unknown): Promise<ToolResult>;
}

export interface CodeEvaluator {
  evaluate(code: string, tools: CodeToolBridge, signal: AbortSignal): Promise<ToolResult>;
}
