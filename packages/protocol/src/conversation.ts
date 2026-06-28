import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import type { ModelConfig } from "./model.ts";

/**
 * A conversation's resolved settings — DERIVED from the cascade + the durable `overrides` layer on
 * every load, never stored. `workspaceRoot` is deliberately NOT here: it is conversation identity
 * (see {@link ConversationRecord}), fixed at creation, not a resolved setting.
 */
export interface ConversationConfig {
  instructions: string;
  model: ModelConfig;
  /** Tool scope (which tools this conversation may use). Enforcement deferred. */
  tools?: { allow?: string[] };
  /** Per-plugin config, validated against each plugin's schema. Read via `ConfigReader`. */
  plugins?: Record<string, unknown>;
}

/**
 * The durable per-conversation settings fragment: the top layer of the cascade, re-applied on every
 * resolve. It distinguishes "the user chose X for this conversation" from "X was the default the day
 * it was created" — so a `/model` switch survives resume while later settings-file edits still reach
 * the conversation. Opaque here (a `SettingsDoc` fragment validated by the config layer); typing it
 * concretely would create a protocol→config dependency cycle.
 */
export type ConversationOverrides = Record<string, unknown>;

/**
 * The durable conversation entity the store persists. It has NO `config` field: config is resolved
 * from the cascade + `overrides` on load (see {@link Conversation}), never frozen at creation.
 */
export interface ConversationRecord {
  id: ConversationId;
  /** The execution workspace root; `null` when projectless. Identity, fixed at creation. */
  workspaceRoot: string | null;
  /** Durable top-of-cascade settings layer; re-applied on every resolve. */
  overrides: ConversationOverrides;
  /** Tip of the active chain; advances on each append. `null` until the first append. */
  head: ItemId | null;
  createdAt: number;
}

/**
 * A record together with its resolved config — the view the engine/service/plugins/CLI consume.
 * `conversation.workspaceRoot` (identity) and `conversation.config.model` (resolved) are both
 * reachable, and the type makes the derived-ness explicit.
 */
export type Conversation = ConversationRecord & { config: ConversationConfig };

/**
 * Resolves a record's identity + overrides into its config. Injected into the engine so
 * `@harness/core` stays free of `@harness/config` (which owns the settings cascade).
 */
export type ConfigResolver = (record: ConversationRecord) => Promise<ConversationConfig>;

/** The durable fields a caller supplies to create a conversation; the store assigns the rest. */
export type NewConversationRecord = {
  workspaceRoot: string | null;
  overrides: ConversationOverrides;
};

export type TurnStatus = "running" | "completed" | "failed" | "aborted";

/**
 * One activation of the loop. Thin: status is a hint, largely derived from items.
 * At most one turn per conversation is `running` at a time.
 */
export interface Turn {
  id: TurnId;
  conversationId: ConversationId;
  status: TurnStatus;
  createdAt: number;
}
