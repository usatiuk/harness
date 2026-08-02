import type { ZodType } from "zod";
import type { ModelCapabilities, ModelMiddleware, ModelProvider } from "./model.ts";
import type { Tool, ToolMiddleware } from "./tools.ts";
import type { ContentBlock } from "./content.ts";
import type { Conversation } from "./conversation.ts";
import type { ConversationId } from "./ids.ts";
import type { HarnessEvent } from "./events.ts";
import type { CompactionStrategy } from "./policies.ts";
import type { RequestMiddleware } from "./requests.ts";

/** Per-conversation context for cache-stable prompt/project instruction sources. */
export interface ContextSourceContext {
  service(key: string): unknown;
}

/** Contributes prompt fragments / project context into the cache-stable prefix. */
export interface ContextSource {
  readonly id: string;
  instructions(ctx: ContextSourceContext): Promise<ContentBlock[]>;
}

/**
 * Builds a per-conversation service a plugin hangs off `ctx.service(key)` — the single
 * mechanism for per-conversation plugin substrate (the execution backend is one, keyed
 * `"execution"`). The kernel calls `for`, caches the result for the loaded runtime, and
 * never inspects it; tools narrow the opaque value with a typed accessor. A provider that owns
 * live resources may dispose its value when that runtime family is deactivated.
 */
export interface ServiceProvider {
  readonly key: string;
  for(conversation: Conversation): unknown;
  dispose?(service: unknown): void | Promise<void>;
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
  /** Plugin ids whose tool middleware must already be registered outside this plugin's chain. */
  readonly toolMiddlewareAfter?: readonly string[];
  providers?(): ModelProvider[];
  tools?(caps: ModelCapabilities, ctx: ToolContributionContext): Tool[];
  /** Wraps tool execution, outermost first. Absence of any gate = allow. */
  toolMiddleware?(): ToolMiddleware[];
  /** Wraps each model step, outermost first (retry / cache / model-fallback). */
  modelMiddleware?(): ModelMiddleware[];
  /** Wraps blocking host interactions, outermost first; the UI request is terminal. */
  requestMiddleware?(): RequestMiddleware[];
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
