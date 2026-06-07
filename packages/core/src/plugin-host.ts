import type {
  ContextPolicy,
  ContextSource,
  Observer,
  Plugin,
  ToolMiddleware,
} from "@harness/protocol";
import { ProviderRegistry, ToolRegistry } from "./registry.ts";
import { defaultContextPolicy, truncateMiddleware } from "./policies.ts";

/** The single composed instance of each policy slot. */
export interface ResolvedPolicies {
  context: ContextPolicy;
}

function pick<T>(slot: string, contributed: T[], fallback: T): T {
  if (contributed.length === 0) return fallback;
  if (contributed.length === 1) return contributed[0]!;
  throw new Error(`multiple ${slot} policies contributed; composition not yet supported`);
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
  /** Outer→inner; contributed first (registration order), default truncate innermost. */
  readonly toolMiddleware: readonly ToolMiddleware[];

  constructor(plugins: readonly Plugin[]) {
    const contextSources: ContextSource[] = [];
    const observers: Observer[] = [];
    const context: ContextPolicy[] = [];
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

      const policies = plugin.policies?.() ?? {};
      if (policies.context) context.push(policies.context);
    }

    this.contextSources = contextSources;
    this.observers = observers;
    this.policies = {
      context: pick("context", context, defaultContextPolicy),
    };
    this.toolMiddleware = [...toolMiddleware, truncateMiddleware()];
  }
}
