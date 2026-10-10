import { readGlobalSettings, updateGlobalPluginConfig, getAuthStore } from "@harness/config";
import { McpRuntime, mcpConfigSchema, mcpFailureMessage, type McpConfig } from "@harness/mcp";
import {
  mcpSettingsGet,
  mcpSettingsSet,
  mcpToolsList,
  mcpTest,
  mcpCredentialSet,
  mcpCredentialDelete,
  mcpAuthStart,
  mcpAuthComplete,
  mcpAuthCancel,
  mcpAuthLogout,
} from "@harness/mcp/client";
import { jsonValueSchema } from "@harness/protocol";
import type { HarnessRpcSession } from "@harness/service";
import { ResponseError, ErrorCodes } from "vscode-jsonrpc";
import { z } from "zod";

export function registerMcpApi(
  session: HarnessRpcSession,
  runtime: McpRuntime,
  home: string,
): { close(): Promise<void> } {
  const lifetime = new AbortController();
  const attempts = new Set<string>();
  const operations = new Set<Promise<unknown>>();
  const config = async (): Promise<McpConfig> =>
    mcpConfigSchema.parse((await readGlobalSettings(home)).plugins?.["mcp"] ?? {});
  const server = async (id: string) => {
    const servers = (await config()).servers;
    const saved = Object.hasOwn(servers, id) ? servers[id] : undefined;
    if (!saved) throw new ResponseError(ErrorCodes.InvalidParams, "Unknown MCP server");
    return saved;
  };
  const guard = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = runtime.run(async () => {
      lifetime.signal.throwIfAborted();
      try {
        return await work();
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ResponseError(ErrorCodes.InvalidParams, "Invalid MCP settings or request");
        const message = mcpFailureMessage(error);
        if (message) throw new ResponseError(-32000, message);
        throw error;
      }
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  session.onRequest(mcpSettingsGet, () =>
    guard(async () => {
      const saved = await config();
      return {
        config: jsonValueSchema.parse(saved),
        active: await runtime.statuses(saved),
        restartRequired: JSON.stringify(saved) !== JSON.stringify(runtime.config),
        credentialBackend: (await getAuthStore(home)) ?? null,
      };
    }),
  );
  session.onRequest(mcpSettingsSet, ({ config: value }) =>
    guard(async () => {
      const saved = mcpConfigSchema.parse(value);
      await updateGlobalPluginConfig(home, "mcp", saved, { replace: true });
      return { restartRequired: true as const };
    }),
  );
  session.onRequest(mcpToolsList, () => guard(async () => runtime.tools()));
  session.onRequest(mcpTest, ({ serverId }, signal) =>
    guard(async () =>
      runtime.test(serverId, await server(serverId), AbortSignal.any([signal, lifetime.signal])),
    ),
  );
  session.onRequest(mcpCredentialSet, ({ serverId, slot, value }) =>
    guard(async () => {
      await runtime.setCredential(serverId, await server(serverId), slot, value);
      return null;
    }),
  );
  session.onRequest(mcpCredentialDelete, ({ serverId, slot }) =>
    guard(async () => {
      await server(serverId);
      await runtime.deleteCredential(serverId, slot);
      return null;
    }),
  );
  session.onRequest(mcpAuthStart, ({ serverId }, signal) =>
    guard(async () => {
      const result = await runtime.startAuth(
        serverId,
        await server(serverId),
        AbortSignal.any([signal, lifetime.signal]),
      );
      for (const id of attempts) if (!runtime.hasAttempt(id)) attempts.delete(id);
      attempts.add(result.attemptId);
      return result;
    }),
  );
  session.onRequest(mcpAuthComplete, ({ attemptId, callbackUrl }) =>
    guard(async () => {
      if (!attempts.has(attemptId))
        throw new ResponseError(ErrorCodes.InvalidParams, "Unknown sign-in attempt");
      await runtime.completeAuth(attemptId, callbackUrl);
      attempts.delete(attemptId);
      return null;
    }),
  );
  session.onRequest(mcpAuthCancel, ({ attemptId }) =>
    guard(async () => {
      if (!attempts.delete(attemptId))
        throw new ResponseError(ErrorCodes.InvalidParams, "Unknown sign-in attempt");
      await runtime.cancelAuth(attemptId);
      return null;
    }),
  );
  session.onRequest(mcpAuthLogout, ({ serverId }) =>
    guard(async () => {
      await runtime.logout(serverId, await server(serverId));
      return null;
    }),
  );
  return {
    async close() {
      lifetime.abort();
      await Promise.all([...attempts].map((id) => runtime.cancelAuth(id)));
      await Promise.allSettled(operations);
    },
  };
}
