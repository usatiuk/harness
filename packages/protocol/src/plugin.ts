import type { ModelProvider } from "./model.ts";
import type { Tool, ToolMiddleware } from "./tools.ts";
import type { ContentBlock } from "./content.ts";
import type { HarnessEvent } from "./events.ts";
import type { ContextPolicy } from "./policies.ts";

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
  context?: ContextPolicy;
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
  policies?(): PluginPolicies;
  observers?(): Observer[];
}
