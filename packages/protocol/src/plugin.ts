import type { ZodType } from "zod";
import type { ModelCapabilities, ModelMiddleware, ModelProvider } from "./model.ts";
import type { Tool, ToolMiddleware } from "./tools.ts";
import type { ContentBlock } from "./content.ts";
import type { Conversation } from "./conversation.ts";
import type { ConversationId } from "./ids.ts";
import type { HarnessEvent } from "./events.ts";
import type { CompactionStrategy } from "./policies.ts";

/** Contributes prompt fragments / project context into the cache-stable prefix. */
export interface ContextSource {
  readonly id: string;
  instructions(): Promise<ContentBlock[]>;
}

/**
 * Builds a per-conversation service a plugin hangs off `ctx.service(key)` — the single
 * mechanism for per-conversation plugin substrate (the execution backend is one, keyed
 * `"execution"`). The kernel calls `for`, caches the result per (conversation, key), and
 * never inspects it; tools narrow the opaque value with a typed accessor.
 */
export interface ServiceProvider {
  readonly key: string;
  for(conversation: Conversation): unknown;
}

/** Read-only event subscriber. The only fan-out; must never mutate state. */
export interface Observer {
  onEvent(event: HarnessEvent): void;
}

export interface PluginPolicies {
  compaction?: CompactionStrategy;
}

/** Per-conversation context supplied when a plugin resolves its turn-local tool roster. */
export interface ToolContributionContext {
  service(key: string): unknown;
}

/**
 * The single extension surface. A plugin contributes typed capabilities; it never
 * touches control flow.
 */
export interface Plugin {
  readonly id: string;
  providers?(): ModelProvider[];
  tools?(caps: ModelCapabilities, ctx: ToolContributionContext): Tool[];
  /** Wraps tool execution, outermost first. Absence of any gate = allow. */
  toolMiddleware?(): ToolMiddleware[];
  /** Wraps each model step, outermost first (retry / cache / model-fallback). */
  modelMiddleware?(): ModelMiddleware[];
  contextSources?(): ContextSource[];
  /** Per-conversation services hung off `ctx.service(key)`; keys must be unique host-wide. */
  services?(): ServiceProvider[];
  policies?(): PluginPolicies;
  observers?(): Observer[];
}

/**
 * Reads a plugin's resolved per-conversation config slice (already validated +
 * defaulted at creation). Handed to a `PluginDefinition` at construction so config
 * reaches the plugin without widening `ToolContext`.
 */
export interface ConfigReader {
  get<C = unknown>(pluginId: string, conversationId: ConversationId): Promise<C>;
}

/**
 * A config-owning plugin: declares its `plugins.<id>` schema (validated centrally,
 * unknown keys rejected) and is built from a `ConfigReader`. Plugins needing no
 * config are plain `Plugin`s.
 */
export interface PluginDefinition {
  readonly id: string;
  readonly configSchema: ZodType;
  create(reader: ConfigReader): Plugin;
}

/** A host accepts either: a plain `Plugin`, or a config-owning `PluginDefinition`. */
export type PluginEntry = Plugin | PluginDefinition;

export const isPluginDefinition = (entry: PluginEntry): entry is PluginDefinition =>
  "create" in entry;
