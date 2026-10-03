import { join } from "node:path";
import { defaultHome, readGlobalSettings } from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import {
  isKernelEvent,
  jsonValueSchema,
  type ModelConfig,
  type PluginEntry,
} from "@harness/protocol";
import { reapStoppedSandboxes, sandboxPlugin } from "@harness/sandbox";
import { activitiesPlugin } from "@harness/activities";
import { agentsPlugin } from "@harness/agents";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import {
  APPROVAL_CLIENT_CONTRACT_VERSION,
  approvalDecideRequest,
  approvalPlugin,
  isApprovalRequest,
} from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { subagentsDefinition } from "@harness/subagents";
import { HarnessService, HarnessRpcSession } from "@harness/service";
import type { RpcConnection } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { modelCompaction } from "@harness/core";
import { QuickJsEvaluator } from "@harness/code-mode";
import { createCustomProviderPlugins } from "@harness/custom-providers";
import { DemoProvider } from "./demo-provider.ts";
import { prepareProviderEntries, providerPlugins } from "./auth.ts";
import { credentialStoreForRead } from "./credential-store.ts";
import { registerFeatureServer } from "./features.ts";
import { registerAppApi } from "./app-api.ts";
import { bootstrapProviders } from "./provider-bootstrap.ts";
export { registerFeatureServer } from "./features.ts";
export const ACTIVITY_APPROVAL_DEFAULTS = {
  activity_wait: "allow",
  activity_peek: "allow",
  activity_list: "allow",
  activity_kill: "allow",
} as const;
const CLIENT_CONTRACTS = [
  { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
  ...FEATURE_PLUGIN_CONTRACTS,
];
export interface ServerHarness {
  service: HarnessService;
  rpcSession: HarnessRpcSession;
  store: SqliteStore;
  close(closePeer?: boolean): Promise<void>;
}
export async function buildServerHarness(
  connection: RpcConnection,
  options: { signal?: AbortSignal } = {},
): Promise<ServerHarness> {
  const startup = new AbortController();
  const closedDuringStartup = connection.onClose(() => startup.abort());
  const signal = options.signal
    ? AbortSignal.any([startup.signal, options.signal])
    : startup.signal;
  signal.throwIfAborted();
  const store = new SqliteStore(join(defaultHome(), "store.db"), undefined, undefined, {
    exclusive: true,
  });
  let startedSession: HarnessRpcSession | undefined;
  let startedAppApi: { close(): Promise<void> } | undefined;
  try {
    const settings = await readGlobalSettings(defaultHome());
    const prepare = prepareProviderEntries(settings);
    const { store: secrets, kind } = await credentialStoreForRead(defaultHome());
    const registry = prepare(secrets);
    const built = await bootstrapProviders(registry, signal);
    const plugins: PluginEntry[] = [...providerPlugins, built.plugin];
    const fallbackModel = built.defaultModel;
    // Config-defined providers (`customProviders` in global settings) join the same registry as
    // signed-in built-ins; their plugin id doubles as the model provider id.
    const customProviders = settings.customProviders;
    plugins.push(...createCustomProviderPlugins(customProviders ?? {}));
    plugins.push(
      { id: "demo", providers: () => [new DemoProvider()] },
      sandboxPlugin,
      activitiesPlugin,
      outputPlugin,
      workspacePlugin,
      approvalPlugin,
      agentsPlugin,
      autoApprovalPlugin,
      subagentsDefinition,
      { id: "compaction", policies: () => ({ compaction: modelCompaction }) },
    );
    const resolvedFallback: ModelConfig = fallbackModel ?? { provider: "demo", model: "demo-1" };
    // Lowest cascade layer: every conversation has a model even on resume with no settings, and
    // resolution never fails "no model configured".
    const service = new HarnessService({
      codeEvaluator: new QuickJsEvaluator(),
      store,
      plugins,
      defaults: {
        model: resolvedFallback,
        plugins: {
          approval: { tools: ACTIVITY_APPROVAL_DEFAULTS },
        },
      },
    });
    void reapStoppedSandboxes();
    // Late-bind the runner so the subagents tool can spawn/observe/abort children. Mirrors the
    // engine's late-binding of `configFor`; safe because no tool runs before the service is built.
    subagentsDefinition.bindRunner(service);
    const rpcSession = new HarnessRpcSession({
      connection,
      service,
      server: { name: "harness", version: "0.0.0" },
      plugins: CLIENT_CONTRACTS,
      defaultModel: resolvedFallback,
      // Handler payloads may contain secrets; report only the failure class.
      onError: (error) =>
        console.error(
          JSON.stringify({
            event: "server.failure",
            kind: error instanceof Error ? error.name : "UnknownError",
          }),
        ),
    });
    startedSession = rpcSession;
    registerFeatureServer(rpcSession, service);
    const appApi = registerAppApi(rpcSession, service, {
      kind,
      entries: registry,
      statuses: built.statuses,
    });
    startedAppApi = appApi;
    const approvalRequests = new Map<string, AbortController>();
    rpcSession.observeEvents((event, rootId) => {
      if (!isKernelEvent(event)) return;
      if (event.type === "request.resolved") {
        approvalRequests.get(event.requestId)?.abort();
        approvalRequests.delete(event.requestId);
        return;
      }
      if (event.type !== "request.created" || !isApprovalRequest(event.request)) return;
      if (approvalRequests.has(event.requestId)) return;
      if (!rpcSession.supportsClientPlugin("approval", APPROVAL_CLIENT_CONTRACT_VERSION)) {
        service.respond(event.conversationId, event.requestId, { decision: "deny" });
        return;
      }
      const controller = new AbortController();
      approvalRequests.set(event.requestId, controller);
      void rpcSession
        .request(
          approvalDecideRequest,
          {
            requestId: event.requestId,
            rootConversationId: rootId,
            conversationId: event.conversationId,
            call: {
              callId: event.request.call.callId,
              name: event.request.call.name,
              args: jsonValueSchema.parse(event.request.call.args),
            },
            relationship: event.request.relationship,
          },
          { signal: controller.signal },
        )
        .then(
          (response) => service.respond(event.conversationId, event.requestId, response),
          () => service.respond(event.conversationId, event.requestId, { decision: "deny" }),
        )
        .finally(() => approvalRequests.delete(event.requestId));
    });
    signal.throwIfAborted();
    closedDuringStartup.dispose();
    rpcSession.start();
    let closed = false;
    return {
      service,
      rpcSession,
      store,
      close: async (closePeer = true) => {
        if (closed) return;
        closed = true;
        try {
          await appApi.close();
          await rpcSession.shutdown(closePeer);
        } finally {
          try {
            subagentsDefinition.resetSession();
          } finally {
            store.close();
          }
        }
      },
    };
  } catch (error) {
    closedDuringStartup.dispose();
    const cleanupErrors: unknown[] = [];
    try {
      await startedAppApi?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await startedSession?.shutdown();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      subagentsDefinition.resetSession();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      store.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "server startup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Headless server entry point. Stdout is exclusively the NDJSON protocol. */
export async function runStdioServer(): Promise<void> {
  const connection = createNdjsonMessageConnection(process.stdin, process.stdout);
  const closed = new Promise<void>((resolvePromise) => connection.onClose(() => resolvePromise()));
  const startup = new AbortController();
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolvePromise) => (resolveSignal = resolvePromise));
  const stop = () => {
    startup.abort();
    resolveSignal();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let server: ServerHarness | undefined;
  try {
    server = await buildServerHarness(connection, { signal: startup.signal });
    await Promise.race([closed, signal]);
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server?.close(true);
  }
}
