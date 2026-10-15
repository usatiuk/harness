import { realpath } from "node:fs/promises";
import {
  WorktreeManager,
  WorktreesDefinition,
  worktreeDirectory,
  worktreesConfigSchema,
} from "@harness/worktrees";
import { conversationTitlesPlugin } from "@harness/conversation-titles";
import { McpRuntime, MCP_CLIENT_CONTRACT_VERSION } from "@harness/mcp";
import { registerMcpApi } from "./mcp.ts";
import { join } from "node:path";
import { PRODUCT_VERSION } from "@harness/release";
import { assertSelectedServer } from "@harness/connections/local";
import {
  defaultHome,
  readGlobalSettings,
  loadMergedSettings,
  setAuthStore,
  validateGlobalPluginScopes,
} from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import { type ModelConfig, type PluginEntry } from "@harness/protocol";
import {
  sandboxWorkspaceRequest,
  sandboxConfigSchema,
  sandboxEnvironmentsRequest,
  sandboxEnvironmentControlRequest,
  createSandboxRuntime,
} from "@harness/sandbox";
import { activitiesPlugin } from "@harness/activities";
import { agentsPlugin } from "@harness/agents";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import { APPROVAL_CLIENT_CONTRACT_VERSION, createApprovalPlugin } from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { SubagentsDefinition } from "@harness/subagents";
import { HarnessService, HarnessRpcSession, HarnessRpcHost } from "@harness/service";
import type { RpcConnection } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { FEATURE_PLUGIN_CONTRACTS } from "@harness/client-features";
import { modelCompaction } from "@harness/core";
import { QuickJsEvaluator } from "@harness/code-mode";
import { DemoProvider } from "./demo-provider.ts";
import { prepareProviderEntries, providerPlugins } from "./auth.ts";
import { credentialStoreForRead, credentialStoreForLogin } from "./credential-store.ts";
import { registerFeatureServer } from "./features.ts";
import { registerAppApi } from "./app-api.ts";
import { bootstrapProviders } from "./provider-bootstrap.ts";
import { registerApprovalServer } from "./approvals.ts";
export { registerFeatureServer } from "./features.ts";
export const ACTIVITY_APPROVAL_DEFAULTS = {
  activity_wait: "allow",
  activity_peek: "allow",
  activity_list: "allow",
  activity_kill: "allow",
} as const;
const CLIENT_CONTRACTS = [
  { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
  { id: "mcp", version: MCP_CLIENT_CONTRACT_VERSION },
  ...FEATURE_PLUGIN_CONTRACTS,
];
export interface ServerComposition {
  service: HarnessService;
  host: HarnessRpcHost;
  store: SqliteStore;
  connect(connection: RpcConnection): HarnessRpcSession;
  close(): Promise<void>;
}
export interface ServerHarness {
  service: HarnessService;
  rpcSession: HarnessRpcSession;
  store: SqliteStore;
  close(): Promise<void>;
}
export async function buildServerComposition(
  options: { signal?: AbortSignal } = {},
): Promise<ServerComposition> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const store = new SqliteStore(join(defaultHome(), "store.db"), undefined, undefined, {
    exclusive: true,
    beforeInitialize: () =>
      assertSelectedServer(defaultHome(), process.env["HARNESS_SERVER_SELECTION"]),
  });
  const subagents = new SubagentsDefinition();
  let closeForDockerFailure: (() => Promise<void>) | undefined;
  const sandbox = createSandboxRuntime(defaultHome(), () => {
    if (!closeForDockerFailure)
      throw new Error("Docker guardian failed before server composition was ready");
    console.error(JSON.stringify({ event: "server.failure", subsystem: "docker-guardian" }));
    void closeForDockerFailure().catch(() =>
      console.error(
        JSON.stringify({ event: "server.shutdown-failed", subsystem: "docker-guardian" }),
      ),
    );
  });
  let mcp: McpRuntime | undefined;
  let startedHost: HarnessRpcHost | undefined;
  try {
    const settings = await readGlobalSettings(defaultHome());
    validateGlobalPluginScopes(settings, new Set(["mcp", "worktrees"]), "global settings", true);
    const prepare = prepareProviderEntries(
      settings,
      providerPlugins,
      join(defaultHome(), "settings.json"),
    );
    const { store: secrets, kind } = await credentialStoreForRead(defaultHome());
    let mcpSecrets = secrets;
    let mcpStoreKind = kind;
    mcp = new McpRuntime(settings.plugins?.["mcp"] ?? {}, {
      get: (key) => mcpSecrets.get(key),
      delete: (key) => mcpSecrets.delete(key),
      async set(key, value) {
        if (mcpStoreKind === null) {
          const selected = await credentialStoreForLogin(defaultHome());
          await selected.store.set(key, value);
          await setAuthStore(defaultHome(), selected.kind);
          mcpSecrets = selected.store;
          mcpStoreKind = selected.kind;
        } else await mcpSecrets.set(key, value);
      },
    });
    await mcp.initialize(signal);
    const mcpRuntime = mcp;
    const registry = prepare(secrets);
    const built = await bootstrapProviders(registry, signal);
    const worktrees = new WorktreeManager(store, async () => {
      const doc = await readGlobalSettings(defaultHome());
      return worktreeDirectory(
        worktreesConfigSchema.parse(doc.plugins?.["worktrees"] ?? {}).directory,
      );
    });
    const worktreesDefinition = new WorktreesDefinition();
    const plugins: PluginEntry[] = [...providerPlugins, built.plugin, conversationTitlesPlugin];
    const fallbackModel = built.defaultModel;
    plugins.push(
      { id: "demo", providers: () => [new DemoProvider()] },
      sandbox.plugin,
      worktreesDefinition,
      activitiesPlugin,
      outputPlugin,
      workspacePlugin,
      createApprovalPlugin((name) => !mcpRuntime.ownsTool(name)),
      mcpRuntime.plugin(),
      agentsPlugin,
      autoApprovalPlugin,
      subagents,
      { id: "compaction", policies: () => ({ compaction: modelCompaction }) },
    );
    const resolvedFallback: ModelConfig = fallbackModel ?? { provider: "demo", model: "demo-1" };
    // Lowest cascade layer: every conversation has a model even on resume with no settings, and
    // resolution never fails "no model configured".
    const service = new HarnessService({
      codeEvaluator: new QuickJsEvaluator(),
      store,
      worktrees,
      removeWorkspaceEnvironment: (path) => sandbox.environments.removeWorkspace(path),
      plugins,
      defaults: {
        model: resolvedFallback,
        tools: { mode: "hybrid" },
        plugins: {
          approval: { tools: ACTIVITY_APPROVAL_DEFAULTS },
        },
      },
    });
    // Late-bind the runner so the subagents tool can spawn/observe/abort children. Mirrors the
    // engine's late-binding of `configFor`; safe because no tool runs before the service is built.
    subagents.bindRunner(service);
    worktreesDefinition.bind(service);
    const host = new HarnessRpcHost(service);
    startedHost = host;
    const sessions = new Map<HarnessRpcSession, { close(): Promise<void> }>();
    let closing: Promise<void> | undefined;
    const appState = {
      signingIn: false,
      settingsTail: Promise.resolve(),
      active: { kind, entries: registry, statuses: built.statuses },
    };
    const connect = (connection: RpcConnection): HarnessRpcSession => {
      if (closing !== undefined) throw new Error("server is stopping");
      const rpcSession = new HarnessRpcSession({
        connection,
        host,
        server: { name: "harness", version: PRODUCT_VERSION },
        plugins: CLIENT_CONTRACTS,
        defaultModel: resolvedFallback,
        onError: (error, method) =>
          console.error(
            JSON.stringify({
              event: "server.failure",
              method,
              kind:
                error instanceof TypeError
                  ? "TypeError"
                  : error instanceof RangeError
                    ? "RangeError"
                    : error instanceof Error
                      ? "Error"
                      : "UnknownError",
            }),
          ),
      });
      registerFeatureServer(rpcSession);
      rpcSession.onRequest(sandboxWorkspaceRequest, async ({ path, action }) => {
        const root = await realpath(path);
        return service.runWorkspaceOperation(root, async () => {
          const managed = await store.getManagedWorktree(root);
          const settings = await loadMergedSettings(defaultHome(), managed?.repository ?? root);
          const config = sandboxConfigSchema.parse(settings.plugins?.["sandbox"] ?? {});
          const owner = { emit: () => {} };
          const environment = await sandbox.environments.acquire(root, config.docker, owner);
          try {
            if (action === "stop") {
              await environment.stop();
              return null;
            }
            const handle = await environment.start();
            return {
              containerId: handle.containerId,
              remoteUser: handle.remoteUser,
              remoteWorkspaceFolder: handle.remoteWorkspaceFolder,
            };
          } finally {
            await environment.release(owner);
          }
        });
      });
      rpcSession.onRequest(sandboxEnvironmentsRequest, (params) =>
        sandbox.environments.inventory(params.limit, params.before ?? undefined),
      );
      rpcSession.onRequest(sandboxEnvironmentControlRequest, async (params) => {
        await sandbox.environments.control(params.id, params.action);
        return null;
      });
      const app = registerAppApi(rpcSession, service, appState);
      const mcpApi = registerMcpApi(rpcSession, mcpRuntime, defaultHome());
      const appApi = {
        async close() {
          await Promise.all([app.close(), mcpApi.close()]);
        },
      };
      sessions.set(rpcSession, appApi);
      connection.onClose(() => {
        void appApi
          .close()
          .finally(() => sessions.delete(rpcSession))
          .catch(() => undefined);
      });
      registerApprovalServer(rpcSession);
      rpcSession.start();
      return rpcSession;
    };
    const close = (): Promise<void> => {
      closing ??= doClose();
      return closing;
    };
    const doClose = async (): Promise<void> => {
      try {
        // Stop shared admission before aborting peer-owned auth interactions. Drain
        // both lifetimes before disposing sessions or the store, including failures.
        const results = await Promise.allSettled([
          host.shutdown(),
          ...[...sessions.values()].map((app) => app.close()),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length > 0) throw new AggregateError(errors, "server shutdown failed");
      } finally {
        try {
          await Promise.all([...sessions.keys()].map((session) => session.shutdown()));
        } finally {
          try {
            try {
              try {
                await sandbox.close();
              } finally {
                await mcpRuntime.close();
              }
            } finally {
              subagents.resetSession();
            }
          } finally {
            store.close();
          }
        }
      }
    };
    closeForDockerFailure = close;
    return { service, host, store, connect, close };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await startedHost?.shutdown();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await sandbox.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      try {
        await mcp?.close();
      } finally {
        subagents.resetSession();
      }
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

export async function buildServerHarness(
  connection: RpcConnection,
  options: { signal?: AbortSignal } = {},
): Promise<ServerHarness> {
  const startup = new AbortController();
  const closedDuringStartup = connection.onClose(() => startup.abort());
  const signal = options.signal
    ? AbortSignal.any([startup.signal, options.signal])
    : startup.signal;
  let composition: ServerComposition | undefined;
  try {
    composition = await buildServerComposition({ signal });
    signal.throwIfAborted();
    const rpcSession = composition.connect(connection);
    const owner = composition;
    return { service: owner.service, store: owner.store, rpcSession, close: () => owner.close() };
  } catch (error) {
    await composition?.close();
    throw error;
  } finally {
    closedDuringStartup.dispose();
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
    if (!startup.signal.aborted || error !== startup.signal.reason) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server?.close();
  }
}
