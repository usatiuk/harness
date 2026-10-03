import type { Conversation } from "./conversation.ts";
import type { TurnId } from "./ids.ts";
import type { Item } from "./items.ts";
import type { ModelInvoker } from "./model.ts";
import type { PluginEvent } from "./events.ts";
import type { OutputRef } from "./tools.ts";
import type { ByteRange } from "./store.ts";

/** Open request envelope; the request owner validates the payload for its `kind`. */
export interface InteractionRequest {
  kind: string;
  [key: string]: unknown;
}

/** The terminal request transport or the next inner request middleware. */
export type RequestHandler = (request: InteractionRequest) => Promise<unknown>;

/** Conversation-scoped capabilities common to every blocking host interaction. */
export interface RequestMiddlewareContext {
  conversation: Conversation;
  turnId: TurnId;
  signal: AbortSignal;
  /** Current active branch, starting at its latest compaction unless explicitly included. */
  active(options?: { includeCompacted?: boolean }): Promise<readonly Item[]>;
  /** Read part of stored tool output, e.g. a bounded preview for approval review. */
  readBlob(ref: OutputRef, range: ByteRange): Promise<Uint8Array>;
  service(key: string): unknown;
  /** Emit ephemeral progress for this interaction; durable meaning belongs in the request owner. */
  emit(event: PluginEvent): void;
  models: ModelInvoker;
}

/**
 * Wraps a correlated host interaction. `next` may be skipped or called once; the
 * core rejects a second call so middleware cannot accidentally create two prompts.
 */
export interface RequestMiddleware {
  readonly id: string;
  wrap(
    request: InteractionRequest,
    ctx: RequestMiddlewareContext,
    next: RequestHandler,
  ): Promise<unknown>;
}
