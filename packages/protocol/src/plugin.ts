import type { ZodType } from "zod";
import type { ModelProvider } from "./model.ts";
import type { Tool, ToolMiddleware } from "./tools.ts";
import type { ContentBlock } from "./content.ts";
import type { ConversationId } from "./ids.ts";
import type { ExecutionProvider } from "./execution.ts";
import type { HarnessEvent } from "./events.ts";
import type { CompactionStrategy } from "./policies.ts";

/** Contributes prompt fragments / project context into the cache-stable prefix. */
export interface ContextSource {
  readonly id: string;
  instructions(): Promise<ContentBlock[]>;
}

/** Read-only event subscriber. The only fan-out; must never mutate state. */
export interface Observer {
  onEvent(event: HarnessEvent): void;
}

export interface PluginPolicies {
  compaction?: CompactionStrategy;
}

/**
 * The single extension surface. A plugin contributes typed capabilities; it never
 * touches control flow.
 */
export interface Plugin {
  readonly id: string;
  providers?(): ModelProvider[];
  tools?(): Tool[];
  /** Wraps tool execution, outermost first. Absence of any gate = allow. */
  toolMiddleware?(): ToolMiddleware[];
  contextSources?(): ContextSource[];
  /** The execution substrate (local/docker/remote). At most one host-wide. */
  execution?(): ExecutionProvider;
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
