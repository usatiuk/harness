import {
  defaultHome,
  readGlobalSettings,
  setAuthStore,
  updateGlobalModel,
  updateGlobalPluginConfig,
} from "@harness/config";
import { approvalConfigSchema } from "@harness/approval";
import { sandboxConfigSchema } from "@harness/sandbox";
import type { HarnessRpcSession } from "@harness/service";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc";
import { authRegistry } from "./auth.ts";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";
import {
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appAuthUrlNotification,
  appSettingsRequest,
  appSettingsUpdateRequest,
} from "./client-protocol.ts";

/** Concrete application configuration/auth composition, separate from core dispatch. */
export function registerAppApi(session: HarnessRpcSession): { close(): Promise<void> } {
  const lifetime = new AbortController();
  const operations = new Set<Promise<unknown>>();
  let signingIn = false;
  const invalid = (message: string): never => {
    throw new ResponseError(ErrorCodes.InvalidParams, message);
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  };
  session.onRequest(appSettingsRequest, async () => {
    const doc = await readGlobalSettings(defaultHome());
    const { store } = await credentialStoreForRead(defaultHome());
    const providers = await Promise.all(
      [...authRegistry(store).values()].map(async ({ method }) => {
        const status = await method.status();
        return {
          id: method.id,
          label: method.label,
          kind: method.kind,
          authenticated: status.authenticated,
          detail: status.detail ?? null,
        };
      }),
    );
    const approval = approvalConfigSchema.parse(doc.plugins?.["approval"] ?? {});
    return {
      home: defaultHome(),
      cwd: process.cwd(),
      platform: process.platform as "win32" | "darwin" | "linux",
      providers,
      settings: {
        model: doc.model ? { ...doc.model, preset: doc.model.preset ?? null } : null,
        approval: {
          inWorkspace: approval.inWorkspace,
          outOfWorkspace: approval.outOfWorkspace,
        },
        sandbox: sandboxConfigSchema.parse(doc.plugins?.["sandbox"] ?? {}).backend,
      },
    };
  });
  session.onRequest(appSettingsUpdateRequest, async (settings) => {
    if (settings.model) {
      await updateGlobalModel(defaultHome(), {
        provider: settings.model.provider,
        model: settings.model.model,
        ...(settings.model.preset === null ? {} : { preset: settings.model.preset }),
      });
    }
    await updateGlobalPluginConfig(defaultHome(), "approval", settings.approval);
    await updateGlobalPluginConfig(defaultHome(), "sandbox", { backend: settings.sandbox });
    return null;
  });
  session.onRequest(appAuthLoginRequest, (params, requestSignal) => {
    if (signingIn) invalid("A provider sign-in is already in progress");
    signingIn = true;
    const operation = (async () => {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      signal.throwIfAborted();
      const { store, kind } = await credentialStoreForLogin(defaultHome());
      const entry = authRegistry(store).get(params.provider);
      if (!entry) return invalid("Unknown authentication provider");
      if (entry.method.kind === "api-key") {
        if (params.key === null) return invalid("An API key is required");
        const issue = entry.method.validate(params.key);
        if (issue) invalid(issue);
        await entry.method.submit(params.key);
      } else {
        if (params.key !== null) invalid("Browser sign-in does not accept an API key");
        await entry.method.login({
          signal,
          onUrl: (url) => {
            void session.notify(appAuthUrlNotification, { url }).catch(() => lifetime.abort());
          },
        });
      }
      signal.throwIfAborted();
      await setAuthStore(defaultHome(), kind);
      await updateGlobalModel(defaultHome(), entry.defaultModel);
      return { restartRequired: true as const };
    })();
    void operation
      .finally(() => {
        signingIn = false;
      })
      .catch(() => undefined);
    return track(operation);
  });
  session.onRequest(appAuthLogoutRequest, ({ provider }) =>
    track(
      (async () => {
        lifetime.signal.throwIfAborted();
        if (signingIn) invalid("Wait for provider sign-in to finish");
        const { store } = await credentialStoreForRead(defaultHome());
        const entry = authRegistry(store).get(provider);
        if (!entry) return invalid("Unknown authentication provider");
        await entry.method.logout();
        return { restartRequired: true as const };
      })(),
    ),
  );
  return {
    close: async () => {
      lifetime.abort();
      await Promise.allSettled(operations);
    },
  };
}
