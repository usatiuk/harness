import type {
  CompactionStrategy,
  ContextSource,
  ExecutionProvider,
  Observer,
  Plugin,
  ToolMiddleware,
} from "@harness/protocol";
import { ProviderRegistry, ToolRegistry } from "./registry.ts";
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
  readonly tools = new ToolRegistry();
  readonly contextSources: readonly ContextSource[];
  readonly observers: readonly Observer[];
  readonly policies: ResolvedPolicies;
  /** The single execution substrate, or `undefined` when no plugin provides one. */
  readonly execution: ExecutionProvider | undefined;
  /** Outer→inner; contributed first (registration order), default truncate innermost. */
  readonly toolMiddleware: readonly ToolMiddleware[];

  constructor(plugins: readonly Plugin[]) {
    const contextSources: ContextSource[] = [];
    const observers: Observer[] = [];
    const compaction: CompactionStrategy[] = [];
    const execution: ExecutionProvider[] = [];
    const toolMiddleware: ToolMiddleware[] = [];

    for (const plugin of plugins) {
      for (const provider of plugin.providers?.() ?? []) {
        this.providers.register(provider);
      }
      for (const tool of plugin.tools?.() ?? []) {
        this.tools.register(tool);
      }
      toolMiddleware.push(...(plugin.toolMiddleware?.() ?? []));
      contextSources.push(...(plugin.contextSources?.() ?? []));
      observers.push(...(plugin.observers?.() ?? []));

      const provided = plugin.execution?.();
      if (provided) execution.push(provided);

      const policies = plugin.policies?.() ?? {};
      if (policies.compaction) compaction.push(policies.compaction);
    }

    this.contextSources = contextSources;
    this.observers = observers;
    this.policies = {
      compaction: pick("compaction", compaction, noCompaction),
    };
    this.execution = pick<ExecutionProvider | undefined>("execution", execution, undefined);
    this.toolMiddleware = [...toolMiddleware, truncateMiddleware()];
  }
}
