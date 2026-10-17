import type { ConversationId, ItemId, TurnId } from "./ids.ts";
import type { ModelConfig } from "./model.ts";
import type { ToolMode } from "./tools.ts";

/**
 * A conversation's resolved settings — DERIVED from the cascade + the durable `overrides` layer on
 * every load, never stored. `workspaceRoot` is deliberately NOT here: it selects execution
 * (see {@link ConversationRecord}), not a resolved setting.
 */
export interface ConversationConfig {
  instructions: string;
  model: ModelConfig;
  /** Tool scope (which tools this conversation may use). Enforced by `PluginHost.toolsFor`. */
  tools?: {
    allow?: string[];
    mode?: ToolMode;
    /** Global preference for deferred tool names in eval instructions; absent means true. */
    showNames?: boolean;
  };
  /** Global proactive compaction threshold; absent uses model capacity. */
  compaction?: { thresholdTokens: number };
  /** Per-plugin config, validated against each plugin's schema. Read via `ConfigReader`. */
  plugins?: Record<string, unknown>;
}

/**
 * The durable top-of-cascade settings layer, re-applied on every resolve: distinguishes a
 * per-conversation choice (e.g. `/model`) from the creation-time default, so the choice survives
 * resume. Opaque (`SettingsDoc` fragment, validated by the config layer) — a concrete type would
 * pull `@harness/config` into the protocol.
 */
export type ConversationOverrides = Record<string, unknown>;

/**
 * The durable conversation entity the store persists. It has NO `config` field: config is resolved
 * from the cascade + `overrides` on load (see {@link Conversation}), never frozen at creation.
 */
export interface ConversationRecord {
  id: ConversationId;
  /** Current execution directory; `null` when projectless. */
  workspaceRoot: string | null;
  /** Original checkout and settings root, retained when execution switches workspaces. */
  originalWorkspaceRoot?: string;
  /** Durable top-of-cascade settings layer; re-applied on every resolve. */
  overrides: ConversationOverrides;
  /** Tip of the active chain; advances on each append. `null` for empty history. */
  head: ItemId | null;
  /** Immutable fork provenance; independent of runtime/subagent ownership. */
  fork?: { conversationId: ConversationId; userMessageId: ItemId };
  /** Saved display title; null until the first user message. */
  title: string | null;
  createdAt: number;
  /** Creation time until the latest accepted nonempty user input. */
  lastUsedAt: number;
}

/**
 * A record together with its resolved config — the view the engine/service/plugins/CLI consume.
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
  /** Original checkout and settings root, retained when execution switches workspaces. */
  originalWorkspaceRoot?: string;
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
