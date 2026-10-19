import { worktreeDirectory, worktreesConfigSchema } from "@harness/worktrees";
import {
  deepMerge,
  readGlobalSettings,
  readGlobalInstructions,
  GlobalInstructionsError,
  updateGlobalInstructions,
  setAuthStore,
  updateGlobalModel,
  updateGlobalPluginConfig,
  updateGlobalSettings,
  type AuthStoreKind,
} from "@harness/config";
import { approvalConfigSchema } from "@harness/approval";
import { conversationTitlesConfigSchema } from "@harness/conversation-titles";
import { autoApprovalConfigSchema } from "@harness/auto-approval";
import { modelRetryConfigSchema } from "@harness/model-retry";
import { subagentsConfigSchema } from "@harness/subagents";
import { sandboxConfigSchema, type SandboxBackend } from "@harness/sandbox";
import {
  projectConversationPage,
  type HarnessRpcSession,
  type HarnessService,
} from "@harness/service";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc";
import {
  ProviderCredentialError,
  ProviderSignInError,
  type ConversationId,
} from "@harness/protocol";
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
  appConversationProjectsRequest,
  appConversationListRequest,
  appAuthLogoutRequest,
  appAuthUrlNotification,
  appSettingsRequest,
  appInstructionsRequest,
  appInstructionsUpdateRequest,
  appProvidersRequest,
  type ProviderStatus,
  appSettingsUpdateRequest,
  appProviderConfigUpdateRequest,
  appProviderCreateRequest,
} from "./client-protocol.ts";

/** Concrete application configuration/auth composition, separate from core dispatch. */
export interface AppApiState {
  readonly home: string;
  signingIn: boolean;
  settingsTail: Promise<void>;
  readonly defaultSandboxBackend: SandboxBackend;
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
  const { home, active } = state;
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
    const doc = await readGlobalSettings(home);
    const prepare = prepareProviderEntries(doc, providerPlugins, join(home, "settings.json"));
    const { store, kind } = await credentialStoreForRead(home);
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
          settings: entry.settings,
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
  session.onRequest(appConversationListRequest, ({ cursor, limit, order, filter }) =>
    projectConversationPage(
      service,
      limit,
      cursor === null ? undefined : { ...cursor, id: cursor.id as ConversationId },
      { order, ...(filter ?? {}), excludedState: { plugin: "subagents", key: "spawn" } },
    ),
  );
  session.onRequest(appConversationProjectsRequest, async ({ limit, cursor }) => {
    const projects = await service.listConversationProjects(limit, cursor ?? undefined, {
      plugin: "subagents",
      key: "spawn",
    });
    return {
      projects: projects.map((project) => ({ ...project })),
      nextCursor: projects.length === limit ? { ...projects.at(-1)! } : null,
    };
  });
  session.onRequest(appProvidersRequest, () => track(listProviders()));
  session.onRequest(appProviderCreateRequest, (params) =>
    track(
      serializeSettings(async () => {
        lifetime.signal.throwIfAborted();
        const { store } = await credentialStoreForRead(home);
        await updateGlobalSettings(home, (doc) => {
          if (prepareProviderEntries(doc)(store).has(params.id) || params.id === "demo")
            return invalid("Provider ID already exists");
          const updated = {
            ...doc,
            providers: {
              ...doc.providers,
              [params.id]: { type: params.type, label: params.label, config: params.config },
            },
          };
          try {
            prepareProviderEntries(updated);
          } catch (error) {
            if (error instanceof ProviderConfigurationError) return invalid(error.message);
            if (
              !providerPlugins.some((plugin) =>
                plugin.providerTypes?.().some((type) => type.type === params.type),
              )
            )
              return invalid("Unknown provider type");
            throw error;
          }
          return updated;
        });
        return { restartRequired: true as const };
      }),
    ),
  );
  session.onRequest(appProviderConfigUpdateRequest, (params) =>
    track(
      serializeSettings(async () => {
        lifetime.signal.throwIfAborted();
        const { store } = await credentialStoreForRead(home);
        await updateGlobalSettings(home, (doc) => {
          const entry = prepareProviderEntries(doc)(store).get(params.provider);
          if (!entry) return invalid("Unknown provider connection");
          for (const key of Object.keys(params.patch))
            if (!entry.settings.some((setting) => setting.key === key))
              return invalid(`Provider setting '${key}' is not editable`);
          const updated = {
            ...doc,
            providers: {
              ...doc.providers,
              [entry.id]: {
                ...doc.providers?.[entry.id],
                type: entry.type,
                config: { ...entry.config, ...params.patch },
              },
            },
          };
          prepareProviderEntries(updated);
          return updated;
        });
        return { restartRequired: true as const };
      }),
    ),
  );
  const instructionsError = (error: unknown): never => {
    if (error instanceof GlobalInstructionsError) throw new ResponseError(-32000, error.message);
    throw error;
  };
  session.onRequest(appInstructionsRequest, () =>
    track(readGlobalInstructions(home).catch(instructionsError)),
  );
  session.onRequest(appInstructionsUpdateRequest, ({ content }) =>
    track(
      serializeSettings(async () => {
        lifetime.signal.throwIfAborted();
        await updateGlobalInstructions(home, content).catch(instructionsError);
        return null;
      }),
    ),
  );
  session.onRequest(appSettingsRequest, async () => {
    const doc = await readGlobalSettings(home);
    const providers = await listProviders();
    const approval = approvalConfigSchema.parse(doc.plugins?.["approval"] ?? {});
    const autoApproval = autoApprovalConfigSchema.parse(doc.plugins?.["auto-approval"] ?? {});
    const subagents = subagentsConfigSchema.parse(doc.plugins?.["subagents"] ?? {});
    const titles = conversationTitlesConfigSchema.parse(doc.plugins?.["conversation-titles"] ?? {});
    const retryConfig = modelRetryConfigSchema.parse(doc.plugins?.["model-retry"] ?? {});
    return {
      home: home,
      cwd: process.cwd(),
      platform: process.platform as "win32" | "darwin" | "linux",
      providers,
      settings: {
        model: doc.model ? { ...doc.model, preset: doc.model.preset ?? null } : null,
        approval: {
          inWorkspace: approval.inWorkspace,
          outOfWorkspace: approval.outOfWorkspace,
          humanApprovalTimeoutSeconds: approval.humanApprovalTimeoutSeconds,
        },
        autoApproval: {
          enabled: autoApproval.enabled,
          timeoutSeconds: autoApproval.timeoutSeconds,
          model: autoApproval.model
            ? { ...autoApproval.model, preset: autoApproval.model.preset ?? null }
            : null,
        },
        conversationTitleModel: titles.model
          ? { ...titles.model, preset: titles.model.preset ?? null }
          : null,
        sandbox: sandboxConfigSchema.parse(
          deepMerge({ backend: state.defaultSandboxBackend }, doc.plugins?.["sandbox"] ?? {}),
        ).backend,
        toolMode: doc.tools?.mode ?? "hybrid",
        showToolNames: doc.tools?.showNames ?? true,
        keepServerRunning: doc.desktop?.keepServerRunning ?? false,
        subagents: { maxDepth: subagents.maxDepth, maxChildren: subagents.maxChildren },
        compactionThresholdTokens: doc.compaction?.thresholdTokens ?? null,
        worktreeDirectory:
          worktreesConfigSchema.parse(doc.plugins?.["worktrees"] ?? {}).directory ?? null,
        modelRetries: { attempts: retryConfig.attempts, backoffMs: retryConfig.backoffMs },
      },
    };
  });
  session.onRequest(appSettingsUpdateRequest, (settings) =>
    track(
      serializeSettings(async () => {
        lifetime.signal.throwIfAborted();
        if (settings.model) {
          await updateGlobalModel(home, {
            provider: settings.model.provider,
            model: settings.model.model,
            ...(settings.model.preset === null ? {} : { preset: settings.model.preset }),
          });
        }
        if (settings.keepServerRunning !== undefined)
          await updateGlobalSettings(home, (doc) => ({
            ...doc,
            desktop: { ...doc.desktop, keepServerRunning: settings.keepServerRunning },
          }));
        const changedPlugins: string[] = [];
        if (settings.approval) {
          await updateGlobalPluginConfig(home, "approval", settings.approval);
          changedPlugins.push("approval");
        }
        if (settings.autoApproval) {
          await updateGlobalPluginConfig(
            home,
            "auto-approval",
            {
              enabled: settings.autoApproval.enabled,
              timeoutSeconds: settings.autoApproval.timeoutSeconds,
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
          changedPlugins.push("auto-approval");
        }
        if (settings.conversationTitleModel !== undefined) {
          await updateGlobalPluginConfig(
            home,
            "conversation-titles",
            {
              ...(settings.conversationTitleModel
                ? {
                    model: {
                      provider: settings.conversationTitleModel.provider,
                      model: settings.conversationTitleModel.model,
                      ...(settings.conversationTitleModel.preset === null
                        ? {}
                        : { preset: settings.conversationTitleModel.preset }),
                    },
                  }
                : {}),
            },
            { replace: true },
          );
          changedPlugins.push("conversation-titles");
        }
        if (settings.subagents) {
          await updateGlobalPluginConfig(home, "subagents", settings.subagents);
          changedPlugins.push("subagents");
        }
        if (settings.modelRetries) {
          await updateGlobalPluginConfig(home, "model-retry", settings.modelRetries, {
            replace: true,
          });
          changedPlugins.push("model-retry");
        }
        if (settings.sandbox)
          await updateGlobalPluginConfig(home, "sandbox", { backend: settings.sandbox });
        const toolMode = settings.toolMode;
        if (toolMode !== undefined || settings.showToolNames !== undefined)
          await updateGlobalSettings(home, (doc) => ({
            ...doc,
            tools: {
              ...doc.tools,
              ...(toolMode === undefined ? {} : { mode: toolMode }),
              ...(settings.showToolNames === undefined
                ? {}
                : { showNames: settings.showToolNames }),
            },
          }));
        if (changedPlugins.length) await service.refreshPluginDefaults(changedPlugins);
        if (settings.worktreeDirectory !== undefined) {
          const directory = settings.worktreeDirectory;
          if (directory !== null) {
            try {
              worktreeDirectory(directory);
            } catch {
              invalid("Worktree directory must be an absolute path");
            }
          }
          await updateGlobalSettings(home, (doc) => {
            const plugins = { ...doc.plugins };
            plugins["worktrees"] = directory === null ? {} : { directory };
            return { ...doc, plugins };
          });
        }
        const thresholdTokens = settings.compactionThresholdTokens;
        if (thresholdTokens !== undefined)
          await updateGlobalSettings(home, (doc) => {
            if (thresholdTokens === null) {
              const remaining = { ...doc };
              delete remaining.compaction;
              return remaining;
            }
            return { ...doc, compaction: { thresholdTokens } };
          });
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
      const doc = await readGlobalSettings(home);
      let prepare: ReturnType<typeof prepareProviderEntries>;
      try {
        prepare = prepareProviderEntries(doc, providerPlugins, join(home, "settings.json"));
      } catch (error) {
        if (error instanceof ProviderConfigurationError) invalid(error.message);
        throw error;
      }
      const { store, kind } = await credentialStoreForLogin(home);
      const entry = prepare(store).get(params.provider);
      const method = entry && authFor(entry, kind);
      if (!entry || !method) return invalid("Unknown authentication provider");
      if (method.kind === "api-key") {
        if (params.key === null) return invalid("An API key is required");
        const issue = method.validate(params.key);
        if (issue) invalid(issue);
        await method.submit(params.key);
      } else {
        if (params.key !== null) invalid("OAuth sign-in does not accept an API key");
        try {
          await method.login({
            flow: params.flow,
            signal,
            onUrl: (url, userCode) => {
              void session
                .notify(appAuthUrlNotification, { url, userCode: userCode ?? null })
                .catch(() => lifetime.abort());
            },
          });
        } catch (error) {
          if (error instanceof ProviderSignInError) throw new ResponseError(-32000, error.message);
          throw error;
        }
      }
      signal.throwIfAborted();
      await setAuthStore(home, kind);
      if (entry.defaultModel) await updateGlobalModel(home, entry.defaultModel);
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
        const { store, kind } = await credentialStoreForRead(home);
        const entry = prepareProviderEntries(await readGlobalSettings(home))(store).get(provider);
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
