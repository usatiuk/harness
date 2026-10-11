import {
  ModelDiscoveryError,
  ProviderCredentialError,
  type ModelConfig,
  type ModelProvider,
  type Plugin,
} from "@harness/protocol";
import type { ProviderEntry } from "./auth.ts";
import type { ProviderStatus } from "./client-protocol.ts";
import { projectModelInfo } from "@harness/service";

export interface ProviderBootstrap {
  plugin: Plugin;
  statuses: ReadonlyMap<string, ProviderStatus>;
  defaultModel?: ModelConfig;
}

export async function bootstrapProviders(
  entries: ReadonlyMap<string, ProviderEntry>,
  signal: AbortSignal,
): Promise<ProviderBootstrap> {
  const providers: ModelProvider[] = [];
  const statuses = new Map<string, ProviderStatus>();
  let defaultModel: ModelConfig | undefined;
  const builds = await Promise.allSettled(
    [...entries.values()].map(async (entry) => {
      const auth = entry.instance.auth;
      const status: ProviderStatus = {
        id: entry.id,
        label: entry.label,
        type: entry.type,
        kind: auth?.kind ?? "none",
        canStore: auth?.kind === "oauth" || (auth?.kind === "api-key" && auth.canStore),
        authenticated: !auth,
        detail: null,
        credentialSource: null,
        registered: false,
        catalog: "missing-credentials",
        modelCount: 0,
        diagnostics: [],
        settings: entry.settings,
      };
      let provider: ModelProvider | null;
      try {
        if (auth) {
          const credentials = await auth.status();
          status.authenticated = credentials.authenticated;
          status.detail = credentials.detail ?? null;
          status.credentialSource = credentials.source ?? null;
        }
        signal.throwIfAborted();
        provider = await entry.instance.buildProvider();
      } catch (error) {
        if (!(error instanceof ProviderCredentialError)) throw error;
        status.catalog = "credentials-unavailable";
        status.diagnostics = [error.message];
        statuses.set(entry.id, status);
        return { entry, provider: null };
      }
      if (provider && provider.provider !== entry.id)
        throw new Error(`Mismatched provider identity '${entry.id}'`);
      status.registered = provider !== null;
      status.catalog = provider ? "ready" : "missing-credentials";
      if (!provider) status.diagnostics = ["No credentials available from the configured source"];
      statuses.set(entry.id, status);
      return { entry, provider };
    }),
  );
  const built = builds.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  // One boot budget includes queued work. Four workers avoid a large gateway fan-out.
  const failure = new AbortController();
  const discovery = AbortSignal.any([signal, failure.signal, AbortSignal.timeout(10_000)]);
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, built.length) }, async () => {
      try {
        while (next < built.length && !failure.signal.aborted) {
          const { entry, provider } = built[next++]!;
          if (!provider?.refreshModels) continue;
          const status = statuses.get(entry.id)!;
          try {
            const result = await provider.refreshModels(discovery);
            status.catalog = result.status;
            status.diagnostics = result.diagnostics;
          } catch (error) {
            if (signal.aborted && error === signal.reason) throw error;
            if (failure.signal.aborted && error === failure.signal.reason) throw error;
            if (discovery.aborted && error === discovery.reason)
              status.diagnostics = ["Catalog discovery exceeded the startup deadline"];
            else if (error instanceof ModelDiscoveryError) status.diagnostics = [error.message];
            else throw error;
            status.catalog = provider.listModels().length ? "degraded" : "failed";
          }
        }
      } catch (error) {
        failure.abort(error);
        throw error;
      }
    }),
  );
  // Drain every owned operation before the caller can release its credential/store lifetime.
  if (failure.signal.aborted) throw failure.signal.reason;
  for (const result of workers) if (result.status === "rejected") throw result.reason;
  signal.throwIfAborted();
  for (const { entry, provider } of built) {
    if (!provider) continue;
    providers.push(provider);
    defaultModel ??= entry.defaultModel;
    const status = statuses.get(entry.id)!;
    const models = provider.listModels();
    const ids = new Set<string>();
    for (const model of models) {
      if (model.provider !== entry.id || ids.has(model.model))
        throw new Error(`Invalid model catalog for provider instance '${entry.id}'`);
      ids.add(model.model);
    }
    status.modelCount = models.length;
    status.diagnostics = status.diagnostics.slice(0, 20);
    if (status.catalog !== "ready")
      console.error(
        JSON.stringify({
          event: "provider.catalog",
          instance: entry.id,
          state: status.catalog,
          modelCount: status.modelCount,
        }),
      );
  }
  if (
    Buffer.byteLength(
      JSON.stringify(providers.flatMap((provider) => provider.listModels().map(projectModelInfo))),
      "utf8",
    ) >
    3 * 1024 * 1024
  )
    throw new ModelDiscoveryError("limit", "Combined model catalog exceeds the 3 MiB RPC budget");
  return {
    plugin: { id: "configured-provider-instances", providers: () => providers },
    statuses,
    ...(defaultModel ? { defaultModel } : {}),
  };
}
