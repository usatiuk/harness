import type {
  CompactionStrategy,
  ContextSource,
  ModelCapabilities,
  ModelMiddleware,
  Observer,
  Plugin,
  ServiceProvider,
  Tool,
  ToolMiddleware,
} from "@harness/protocol";
import { ProviderRegistry, ToolSet } from "./registry.ts";
import { noCompaction, truncateMiddleware } from "./policies.ts";

/** The single composed instance of each policy slot. */
export interface ResolvedPolicies {
  compaction: CompactionStrategy;
}

function pick<T>(slot: string, contributed: T[], fallback: T): T {
  if (contributed.length === 0) return fallback;
  if (contributed.length === 1) return contributed[0]!;
  throw new Error(`multiple ${slot} contributions; composition not yet supported`);
}

/**
 * Composes plugin contributions into the fixed registries and policy slots the
 * loop consults. This is mechanism — it never touches control flow.
 */
export class PluginHost {
  readonly providers = new ProviderRegistry();
  /** Per-plugin tool contributors; resolved against the active model's capabilities per turn. */
  readonly #toolContributors: readonly ((caps: ModelCapabilities) => Tool[])[];
  readonly contextSources: readonly ContextSource[];
  readonly observers: readonly Observer[];
  readonly policies: ResolvedPolicies;
  /** Per-conversation service providers by key, for `ctx.service(key)`. */
  readonly services: ReadonlyMap<string, ServiceProvider>;
  /** Outer→inner; contributed first (registration order), default truncate innermost. */
  readonly toolMiddleware: readonly ToolMiddleware[];
  /** Outer→inner (registration order); absence = direct provider stream. */
  readonly modelMiddleware: readonly ModelMiddleware[];

  constructor(plugins: readonly Plugin[]) {
    const contextSources: ContextSource[] = [];
    const observers: Observer[] = [];
    const compaction: CompactionStrategy[] = [];
    const services = new Map<string, ServiceProvider>();
    const toolContributors: ((caps: ModelCapabilities) => Tool[])[] = [];
    const toolMiddleware: ToolMiddleware[] = [];
    const modelMiddleware: ModelMiddleware[] = [];

    for (const plugin of plugins) {
      for (const provider of plugin.providers?.() ?? []) {
        this.providers.register(provider);
      }
      if (plugin.tools) toolContributors.push(plugin.tools.bind(plugin));
      toolMiddleware.push(...(plugin.toolMiddleware?.() ?? []));
      modelMiddleware.push(...(plugin.modelMiddleware?.() ?? []));
      contextSources.push(...(plugin.contextSources?.() ?? []));
      observers.push(...(plugin.observers?.() ?? []));

      for (const service of plugin.services?.() ?? []) {
        if (services.has(service.key)) {
          throw new Error(`duplicate service key: ${service.key}`);
        }
        services.set(service.key, service);
      }

      const policies = plugin.policies?.() ?? {};
      if (policies.compaction) compaction.push(policies.compaction);
    }

    this.#toolContributors = toolContributors;
    this.contextSources = contextSources;
    this.observers = observers;
    this.policies = {
      compaction: pick("compaction", compaction, noCompaction),
    };
    this.services = services;
    this.toolMiddleware = [...toolMiddleware, truncateMiddleware()];
    this.modelMiddleware = modelMiddleware;
  }

  /**
   * The tools to offer the active model, narrowed to the conversation's `tools.allow` scope when set.
   * Withholding (not executing) is the point: it scopes a subagent's tool set and bounds recursion
   * structurally — a disallowed call is rejected by the dispatch's `unknown tool` path, no tool-side guard.
   */
  toolsFor(caps: ModelCapabilities, allow?: readonly string[]): ToolSet {
    const tools = this.#toolContributors.flatMap((contribute) => contribute(caps));
    return new ToolSet(allow ? tools.filter((tool) => allow.includes(tool.name)) : tools);
  }
}
