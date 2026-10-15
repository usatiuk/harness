import type { ZodType } from "zod";
import type { ModelCapabilities, ModelMiddleware, ModelProvider, ModelInvoker } from "./model.ts";
import type { Tool, ToolMiddleware, ToolContractResolver } from "./tools.ts";
import type { ContentBlock } from "./content.ts";
import type { Conversation } from "./conversation.ts";
import type { ConversationId } from "./ids.ts";
import type { DeliveryInput } from "./delivery.ts";
import type { Item } from "./items.ts";
import type { HarnessEvent } from "./events.ts";
import type { CompactionStrategy } from "./policies.ts";
import type { RequestMiddleware } from "./requests.ts";
import type { ProviderTypeContributions } from "./provider-instance.ts";

/** Per-conversation context for cache-stable prompt/project instruction sources. */
export interface ContextSourceContext {
  service(key: string): unknown;
  readonly toolNames: readonly string[];
}

/** Contributes prompt fragments / project context into the cache-stable prefix. */
export interface ContextSource {
  readonly id: string;
  instructions(ctx: ContextSourceContext): Promise<ContentBlock[]>;
}

/** Capabilities for a plugin reacting to a persisted delivery. Background work belongs
 * to its service: supply its cancellation signal and drain it in dispose. */
export interface ConversationInputContext {
  conversation: Conversation;
  rootConversationId: ConversationId;
  input: DeliveryInput;
  item: Item;
  signal: AbortSignal;
  model(signal: AbortSignal): ModelInvoker;
  updateTitle(title: string, expected: string | null): Promise<void>;
}

/**
 * Builds a per-conversation service a plugin hangs off `ctx.service(key)` — the single
 * mechanism for per-conversation plugin substrate (the execution backend is one, keyed
 * `"execution"`). The kernel calls `for`, caches the result for the loaded runtime, and
 * never inspects it; tools narrow the opaque value with a typed accessor. A provider that owns
 * live resources may dispose its value when that conversation tree is deactivated.
 */
export interface ServiceProvider {
  /** Workspace services are replaced when a conversation switches its execution directory. */
  readonly scope?: "workspace";
  readonly key: string;
  for(conversation: Conversation): unknown;
  /** Runs after an input is persisted, before agent work resumes. */
  onInput?(service: unknown, context: ConversationInputContext): void | Promise<void>;
  /** Prompt cancellation of service-owned work; dispose still owns drainage. */
  cancel?(service: unknown): void;
  /**
   * Optional graceful-close policy check after the root scope has stopped admitting new work.
   * The service must not independently start work after this point. This does not authorize
   * disposal; `dispose` must still safely own all resource cleanup.
   */
  blocksDeactivation?(service: unknown): boolean;
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
export interface Plugin extends ProviderTypeContributions {
  readonly id: string;
  /** Plugin ids whose tool middleware must already be registered outside this plugin's chain. */
  readonly toolMiddlewareAfter?: readonly string[];
  providers?(): ModelProvider[];
  tools?(caps: ModelCapabilities, ctx: ToolContributionContext): Tool[];
  /** Resolve callable documentation for direct declarations and code discovery alike. */
  toolContracts?(): ToolContractResolver[];
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
export interface PluginDefinition extends ProviderTypeContributions {
  readonly id: string;
  readonly configSchema: ZodType;
  /** Host startup configuration cannot be supplied by projects/profiles/conversations. */
  readonly configScope?: "global";
  /** Copy this plugin's effective parent slice into a child's durable overrides. */
  readonly inheritConfig?: boolean;
  create(reader: ConfigReader): Plugin;
}

/** A host accepts either: a plain `Plugin`, or a config-owning `PluginDefinition`. */
export type PluginEntry = Plugin | PluginDefinition;

export const isPluginDefinition = (entry: PluginEntry): entry is PluginDefinition =>
  "create" in entry;
