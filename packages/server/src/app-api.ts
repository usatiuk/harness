import {
  defaultHome,
  readGlobalSettings,
  setAuthStore,
  updateGlobalModel,
  updateGlobalPluginConfig,
  type AuthStoreKind,
} from "@harness/config";
import { approvalConfigSchema } from "@harness/approval";
import { autoApprovalConfigSchema } from "@harness/auto-approval";
import { sandboxConfigSchema } from "@harness/sandbox";
import type { HarnessRpcSession, HarnessService } from "@harness/service";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc";
import { ProviderCredentialError } from "@harness/protocol";
import {
  authRegistry,
  authEntries,
  prepareProviderEntries,
  providerPlugins,
  ProviderConfigurationError,
  type ProviderEntry,
} from "./auth.ts";
import { join } from "node:path";
import { credentialStoreForLogin, credentialStoreForRead } from "./credential-store.ts";
import {
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appAuthUrlNotification,
  appSettingsRequest,
  appProvidersRequest,
  type ProviderStatus,
  appSettingsUpdateRequest,
} from "./client-protocol.ts";

/** Concrete application configuration/auth composition, separate from core dispatch. */
export function registerAppApi(
  session: HarnessRpcSession,
  service: HarnessService,
  active?: {
    kind: AuthStoreKind | null;
    entries: ReadonlyMap<string, ProviderEntry>;
    statuses: ReadonlyMap<string, ProviderStatus>;
  },
): { close(): Promise<void> } {
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
  const listProviders = async (): Promise<ProviderStatus[]> => {
    const doc = await readGlobalSettings(defaultHome());
    const prepare = prepareProviderEntries(
      doc,
      providerPlugins,
      join(defaultHome(), "settings.json"),
    );
    const { store } = await credentialStoreForRead(defaultHome());
    return Promise.all(
      [...prepare(store).values()].map(async (entry) => {
        const method = entry.instance.auth;
        const prior = active?.statuses.get(entry.id);
        const status: ProviderStatus = {
          id: entry.id,
          label: entry.label,
          type: entry.type,
          kind: method?.kind ?? "none",
          canStore: method?.kind === "oauth" || (method?.kind === "api-key" && method.canStore),
          authenticated: !method,
          detail: null,
          credentialSource: null,
          registered: prior?.registered ?? false,
          catalog: prior?.catalog ?? "missing-credentials",
          modelCount: prior?.modelCount ?? 0,
          diagnostics: prior?.diagnostics ?? [],
        };
        if (method)
          try {
            const credentials = await method.status();
            status.authenticated = credentials.authenticated;
            status.detail = credentials.detail ?? null;
            status.credentialSource =
              credentials.source ??
              (method.kind === "oauth" && credentials.authenticated ? "stored" : null);
          } catch (error) {
            if (!(error instanceof ProviderCredentialError)) throw error;
            status.catalog = "credentials-unavailable";
            status.diagnostics = [error.message];
          }
        return status;
      }),
    );
  };
  session.onRequest(appProvidersRequest, () => track(listProviders()));
  session.onRequest(appSettingsRequest, async () => {
    const doc = await readGlobalSettings(defaultHome());
    const providers = await listProviders();
    const approval = approvalConfigSchema.parse(doc.plugins?.["approval"] ?? {});
    const autoApproval = autoApprovalConfigSchema.parse(doc.plugins?.["auto-approval"] ?? {});
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
        autoApproval: {
          enabled: autoApproval.enabled,
          model: autoApproval.model
            ? { ...autoApproval.model, preset: autoApproval.model.preset ?? null }
            : null,
        },
        sandbox: sandboxConfigSchema.parse(doc.plugins?.["sandbox"] ?? {}).backend,
      },
    };
  });
  session.onRequest(appSettingsUpdateRequest, (settings) =>
    track(
      (async () => {
        lifetime.signal.throwIfAborted();
        if (settings.model) {
          await updateGlobalModel(defaultHome(), {
            provider: settings.model.provider,
            model: settings.model.model,
            ...(settings.model.preset === null ? {} : { preset: settings.model.preset }),
          });
        }
        await updateGlobalPluginConfig(defaultHome(), "approval", settings.approval);
        await updateGlobalPluginConfig(
          defaultHome(),
          "auto-approval",
          {
            enabled: settings.autoApproval.enabled,
            ...(settings.autoApproval.model
              ? {
                  model: {
                    provider: settings.autoApproval.model.provider,
                    model: settings.autoApproval.model.model,
                    ...(settings.autoApproval.model.preset === null
                      ? {}
                      : { preset: settings.autoApproval.model.preset }),
                  },
                }
              : {}),
          },
          { replace: true },
        );
        await updateGlobalPluginConfig(defaultHome(), "sandbox", { backend: settings.sandbox });
        await service.refreshPluginDefaults(["approval", "auto-approval"]);
        return null;
      })(),
    ),
  );
  session.onRequest(appAuthLoginRequest, (params, requestSignal) => {
    if (signingIn) invalid("A provider sign-in is already in progress");
    signingIn = true;
    const operation = (async () => {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      signal.throwIfAborted();
      const doc = await readGlobalSettings(defaultHome());
      let prepare: ReturnType<typeof prepareProviderEntries>;
      try {
        prepare = prepareProviderEntries(
          doc,
          providerPlugins,
          join(defaultHome(), "settings.json"),
        );
      } catch (error) {
        if (error instanceof ProviderConfigurationError) invalid(error.message);
        throw error;
      }
      const { store, kind } = await credentialStoreForLogin(defaultHome());
      const entry = authEntries(prepare(store)).get(params.provider);
      if (!entry) return invalid("Unknown authentication provider");
      if (active?.kind === kind && entry.method.kind === "oauth")
        entry.method = active.entries.get(params.provider)?.instance.auth ?? entry.method;
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
      if (entry.defaultModel) await updateGlobalModel(defaultHome(), entry.defaultModel);
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
        const { store, kind } = await credentialStoreForRead(defaultHome());
        const entry = authRegistry(store, await readGlobalSettings(defaultHome())).get(provider);
        if (!entry) return invalid("Unknown authentication provider");
        if (active?.kind === kind && entry.method.kind === "oauth")
          entry.method = active.entries.get(provider)?.instance.auth ?? entry.method;
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
