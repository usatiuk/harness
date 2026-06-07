import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import type { ModelConfig } from "./model.ts";

/**
 * The resolved settings snapshot for one conversation: the cascade (global <
 * project < profile < overrides) collapsed once at creation and frozen here.
 * Editing settings files later affects only new conversations.
 */
export interface ConversationConfig {
  instructions: string;
  model: ModelConfig;
  /** The execution workspace root; `null`/absent when projectless. */
  workspaceRoot?: string | null;
  /** Tool scope (which tools this conversation may use). Enforcement deferred. */
  tools?: { allow?: string[] };
  /** Per-plugin config, validated against each plugin's schema. Read via `ConfigReader`. */
  plugins?: Record<string, unknown>;
}

/** Durable root: owns one ordered item log + config. */
export interface Conversation {
  id: ConversationId;
  config: ConversationConfig;
  /** Tip of the active chain; the only mutable cell. `null` until the first append. */
  head: ItemId | null;
  createdAt: number;
}

export type NewConversation = { config: ConversationConfig };

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
