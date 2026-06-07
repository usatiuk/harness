import type { ConversationId, TurnId } from "./ids.ts";
import type { ModelConfig } from "./model.ts";

export interface ConversationConfig {
  instructions: string;
  model: ModelConfig;
}

/** Durable root: owns one ordered item log + config. */
export interface Conversation {
  id: ConversationId;
  config: ConversationConfig;
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
