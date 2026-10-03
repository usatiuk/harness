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
export interface AppApiState {
  signingIn: boolean;
  settingsTail: Promise<void>;
  readonly active: {
    kind: AuthStoreKind | null;
    entries: ReadonlyMap<string, ProviderEntry>;
    statuses: ReadonlyMap<string, ProviderStatus>;
  };
}

export function registerAppApi(
  session: HarnessRpcSession,
  service: HarnessService,
  state: AppApiState,
): { close(): Promise<void> } {
  const active = state.active;
  const lifetime = new AbortController();
  const operations = new Set<Promise<unknown>>();
  const serializeSettings = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = state.settingsTail.then(operation);
    state.settingsTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const invalid = (message: string): never => {
    throw new ResponseError(ErrorCodes.InvalidParams, message);
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  };
  const authFor = (entry: ProviderEntry, kind: AuthStoreKind | null) => {
    const running = active.entries.get(entry.id);
    // Reuse the live OAuth owner so logout and login drain its token rotation.
    // A settings edit can change a named connection's type before restart.
    return active.kind === kind &&
      running?.type === entry.type &&
      running.instance.auth?.kind === "oauth" &&
      entry.instance.auth?.kind === "oauth"
      ? running.instance.auth
      : entry.instance.auth;
  };
  const listProviders = async (): Promise<ProviderStatus[]> => {
    const doc = await readGlobalSettings(defaultHome());
    const prepare = prepareProviderEntries(
      doc,
      providerPlugins,
      join(defaultHome(), "settings.json"),
    );
    const { store, kind } = await credentialStoreForRead(defaultHome());
    return Promise.all(
      [...prepare(store).values()].map(async (entry) => {
        const method = authFor(entry, kind);
        const prior =
          active.entries.get(entry.id)?.type === entry.type
            ? active.statuses.get(entry.id)
            : undefined;
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
            status.credentialSource = credentials.source ?? null;
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
      serializeSettings(async () => {
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
      }),
    ),
  );
  session.onRequest(appAuthLoginRequest, (params, requestSignal) => {
    if (state.signingIn) invalid("A provider sign-in is already in progress");
    state.signingIn = true;
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
      const entry = prepare(store).get(params.provider);
      const method = entry && authFor(entry, kind);
      if (!entry || !method) return invalid("Unknown authentication provider");
      if (method.kind === "api-key") {
        if (params.key === null) return invalid("An API key is required");
        const issue = method.validate(params.key);
        if (issue) invalid(issue);
        await method.submit(params.key);
      } else {
        if (params.key !== null) invalid("Browser sign-in does not accept an API key");
        await method.login({
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
        state.signingIn = false;
      })
      .catch(() => undefined);
    return track(operation);
  });
  session.onRequest(appAuthLogoutRequest, ({ provider }) =>
    track(
      (async () => {
        lifetime.signal.throwIfAborted();
        if (state.signingIn) invalid("Wait for provider sign-in to finish");
        const { store, kind } = await credentialStoreForRead(defaultHome());
        const entry = prepareProviderEntries(await readGlobalSettings(defaultHome()))(store).get(
          provider,
        );
        const method = entry && authFor(entry, kind);
        if (!method) return invalid("Unknown authentication provider");
        await method.logout();
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
