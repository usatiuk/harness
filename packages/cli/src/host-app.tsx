import { decodeConversation } from "@harness/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { Select, Spinner, TextInput, ConfirmInput, PasswordInput } from "@inkjs/ui";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hostSchema, type Host } from "@harness/connections";
import { discoverWsl } from "@harness/connections/node";
import {
  appAuthLoginRequest,
  appAuthUrlNotification,
  appAuthLogoutRequest,
  appProvidersRequest,
  appSettingsRequest,
  appSettingsUpdateRequest,
  type ProviderStatus,
} from "@harness/server/client-protocol";
import { formatError } from "@harness/protocol";
import { TuiHosts, type TuiHostView } from "./hosts.ts";
import { loadSession, Root, launchOverrides, type Start } from "./session-app.tsx";
import { McpSettings } from "./mcp-settings.tsx";
import type { LaunchOptions } from "./launch-options.ts";

export async function launchConnected(options: LaunchOptions): Promise<void> {
  if (options.host && options.ssh) throw new Error("Choose --host or --ssh");
  const hosts = new TuiHosts();
  await hosts.initialize(options.ssh, options.host);
  try {
    await render(<HostApp hosts={hosts} options={options} />, {
      exitOnCtrlC: false,
      incrementalRendering: true,
    }).waitUntilExit();
  } finally {
    await hosts.close();
  }
}

export function HostApp({ hosts, options = {} }: { hosts: TuiHosts; options?: LaunchOptions }) {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);
  const { exit } = useApp();
  const [managing, setManaging] = useState(false);
  const [loaded, setLoaded] = useState<{ hostId: string; generation: number; start: Start }>();
  const [failure, setFailure] = useState<{ hostId: string; generation: number; text: string }>();
  const [initialHostId] = useState(hosts.selected?.host.id);
  const [generation, setGeneration] = useState(0);
  const view = hosts.selected;
  const connected = Boolean(view?.harness?.client.peer.ready);
  const workspace =
    view?.presentation.workspace ?? (view?.host.id === initialHostId ? options.cwd : undefined);
  const start =
    loaded?.hostId === view?.host.id && loaded?.generation === generation
      ? loaded.start
      : undefined;
  const error =
    failure?.hostId === view?.host.id && failure?.generation === generation
      ? failure.text
      : undefined;
  useInput((input, key) => {
    if (key.ctrl && input === "g") {
      setManaging((v) => !v);
      setGeneration((v) => v + 1);
    }
    if (key.ctrl && input === "d" && (managing || !connected)) exit();
  });
  useEffect(() => {
    let mounted = true;
    if (managing || !view || view.disconnected || view.error) return;
    void (async () => {
      const ready = await hosts.connect(view.host.id);
      if (!mounted) return;
      const harness = ready.harness!;
      let next: Start;
      const active =
        ready.presentation.activeId ?? (generation === 0 ? options.conversationId : undefined);
      if (active) next = { kind: "session", session: await loadSession(harness.service, active) };
      else if (generation === 0 && options.resume) next = { kind: "picker" };
      else {
        const cwd =
          ready.host.kind === "local"
            ? resolve(workspace ?? process.cwd())
            : (workspace ?? (await harness.client.peer.request(appSettingsRequest, {})).cwd);
        if (!mounted) return;
        const overrides = launchOverrides(harness.fallbackModel, options.model);
        const conversation =
          generation === 0 && options.worktree
            ? decodeConversation(await harness.plugins.createWorktreeConversation(cwd, overrides))
            : await harness.service.createConversation({ cwd, overrides });
        if (!mounted) {
          await harness.service.deleteConversationIfEmpty(conversation.id);
          return;
        }
        hosts.setActive(ready.host.id, conversation.id);
        next = { kind: "session", session: await loadSession(harness.service, conversation.id) };
      }
      if (mounted) setLoaded({ hostId: view.host.id, generation, start: next });
    })().catch((cause: unknown) => {
      if (mounted) setFailure({ hostId: view.host.id, generation, text: formatError(cause) });
    });
    return () => {
      mounted = false;
    };
  }, [
    view,
    managing,
    generation,
    hosts,
    options.conversationId,
    options.resume,
    options.worktree,
    options.model,
    workspace,
  ]);
  const resume = () => {
    setManaging(false);
    setGeneration((v) => v + 1);
  };
  return (
    <Box flexDirection="column">
      <Text
        bold
      >{`Host: ${view?.host.label ?? "Local"} · Ctrl+G / /hosts: agent command center`}</Text>
      {managing ? (
        <CommandCenter
          hosts={hosts}
          onDone={resume}
          onWorkspace={(path) => {
            if (view) hosts.newConversation(view.host.id, path);
            resume();
          }}
          onNew={() => {
            if (view) hosts.newConversation(view.host.id);
            resume();
          }}
        />
      ) : error ? (
        <>
          <Text color="red">{error}</Text>
          <Text>Ctrl+G to edit or reconnect</Text>
        </>
      ) : !connected && (view?.disconnected || view?.error) ? (
        <>
          <Text color="red">{view.error ?? "Host disconnected"}</Text>
          <Text>Ctrl+G to reconnect</Text>
        </>
      ) : !start || !view?.harness ? (
        <Spinner label={view?.progress ?? "Connecting"} />
      ) : (
        <Root
          key={`${view.host.id}:${generation}`}
          service={view.harness.service}
          plugins={view.harness.plugins}
          providerLabels={Object.fromEntries(
            view.harness.providers.map(({ id, label }) => [id, label]),
          )}
          start={start}
          cwd={
            workspace ??
            (start.kind === "session" ? (start.session.conversation.workspaceRoot ?? ".") : ".")
          }
          drafts={view.presentation.drafts}
          onHosts={() => {
            setManaging(true);
            setGeneration((v) => v + 1);
          }}
          onActive={(id) => {
            if (id) hosts.setActive(view.host.id, id);
          }}
        />
      )}
    </Box>
  );
}

function CommandCenter({
  hosts,
  onDone,
  onWorkspace,
  onNew,
}: {
  hosts: TuiHosts;
  onDone: () => void;
  onWorkspace: (path: string) => void;
  onNew: () => void;
}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<
    | "menu"
    | "hosts"
    | "actions"
    | "edit"
    | "wsl"
    | "workspace"
    | "confirm"
    | "auth"
    | "settings"
    | "mcp"
  >("menu");
  const [editing, setEditing] = useState<Host>();
  const [distributions, setDistributions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<{ label: string; run: () => Promise<void> }>();
  const view = hosts.selected;
  const act = (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    void run()
      .catch((cause: unknown) => setError(formatError(cause)))
      .finally(() => setBusy(false));
  };
  const add = (kind: "wsl" | "ssh", distribution = "") => {
    const common = {
      id: randomUUID(),
      label: kind === "wsl" ? `WSL: ${distribution}` : "SSH",
    };
    setEditing(
      kind === "wsl"
        ? { ...common, kind, distribution, user: null }
        : { ...common, kind, destination: "" },
    );
    setScreen("edit");
  };
  useInput((_input, key) => {
    if (key.escape) {
      if (busy && view) hosts.cancel(view.host.id);
      else if (screen === "menu") onDone();
      else {
        setScreen("menu");
        setError(undefined);
      }
    }
  });
  const menu = [
    { label: "Select host", value: "hosts" },
    { label: "Selected host controls", value: "actions" },
    { label: "Add WSL", value: "wsl" },
    { label: "Add SSH", value: "ssh" },
    { label: "New conversation", value: "new" },
    { label: "Set workspace path on selected host", value: "workspace" },
    { label: "Provider sign-in / sign-out", value: "auth" },
    { label: "Selected host defaults", value: "settings" },
    { label: "MCP servers / permissions / credentials", value: "mcp" },
    {
      label: `Desktop exit: ${hosts.config?.desktop.keepServerRunning ? "keep Local running" : "stop Local when alone"}`,
      value: "preference",
    },
    { label: "Return to conversation", value: "done" },
    { label: "Quit TUI (keep servers running)", value: "quit" },
  ];
  const actions = [
    "Connect / select",
    "Reconnect",
    "Disconnect",
    "Upload current build",
    "Stop server",
    "Restart server",
    "Edit",
    "Remove",
    "Back",
  ].map((label) => ({ label, value: label }));
  const choose = (value: string) => {
    if (value === "done") onDone();
    else if (value === "quit") exit();
    else if (value === "ssh") add("ssh");
    else if (value === "preference")
      act(() =>
        hosts.edit({
          type: "preferences",
          keepServerRunning: !hosts.config!.desktop.keepServerRunning,
        }),
      );
    else if (value === "wsl")
      act(async () => {
        setDistributions(await discoverWsl());
        setScreen("wsl");
      });
    else if (value === "new") onNew();
    else setScreen(value as typeof screen);
  };
  return (
    <Box flexDirection="column">
      <Text bold>Agent command center</Text>
      <Text
        dimColor
      >{`Selected: ${view?.host.label} · ${view?.harness?.client.peer.ready ? "connected" : "disconnected"} · Esc back/cancel`}</Text>
      {view?.runtime && view.identity?.buildId !== view.runtime.buildId && (
        <Text color="yellow">New build ready; restart to use it.</Text>
      )}
      {error && <Text color="red">{error}</Text>}
      {busy ? (
        <Spinner label={view?.progress ?? "Working"} />
      ) : screen === "menu" ? (
        <Select key="menu" options={menu} onChange={choose} />
      ) : screen === "hosts" ? (
        <Select
          key="hosts"
          options={hosts.config!.hosts.map((host) => ({
            label: `${host.label} · ${hosts.views.get(host.id)?.harness?.client.peer.ready ? "connected" : "disconnected"}`,
            value: host.id,
          }))}
          onChange={(id) =>
            act(async () => {
              await hosts.select(id);
              onDone();
            })
          }
        />
      ) : screen === "wsl" ? (
        <Select
          key="wsl"
          options={[
            ...distributions.map((name) => ({ label: name, value: name })),
            { label: "Enter a distribution name", value: "" },
          ]}
          onChange={(name) => add("wsl", name)}
        />
      ) : screen === "edit" && editing ? (
        <HostEditor
          host={editing}
          onSave={(host) =>
            act(async () => {
              await hosts.edit({ type: "host.save", host });
              setScreen("menu");
            })
          }
        />
      ) : screen === "workspace" ? (
        <>
          <Text>Workspace path interpreted on {view?.host.label}:</Text>
          <TextInput onSubmit={onWorkspace} />
        </>
      ) : screen === "confirm" && confirm ? (
        <>
          <Text color="yellow">{confirm.label}</Text>
          <ConfirmInput
            onConfirm={() =>
              act(async () => {
                await confirm.run();
                setScreen("menu");
              })
            }
            onCancel={() => setScreen("actions")}
          />
        </>
      ) : screen === "auth" && view?.harness ? (
        <ProviderAuth view={view} onError={setError} />
      ) : screen === "mcp" && view?.harness ? (
        <McpSettings view={view} onError={setError} />
      ) : screen === "settings" && view?.harness ? (
        <HostSettings view={view} onError={setError} />
      ) : screen === "actions" && view ? (
        <Select
          key="actions"
          options={actions}
          onChange={(value) => {
            const id = view.host.id;
            if (value === "Back") setScreen("menu");
            else if (value === "Edit") {
              setEditing(view.host);
              setScreen("edit");
            } else if (value === "Remove")
              act(async () => {
                await hosts.edit({ type: "host.remove", id });
                setScreen("menu");
              });
            else if (value === "Stop server" || value === "Restart server") {
              setConfirm({
                label: `${value} and affect every client on ${view.host.label}?`,
                run: () => (value === "Stop server" ? hosts.stop(id) : hosts.restart(id)),
              });
              setScreen("confirm");
            } else
              act(() =>
                value === "Connect / select"
                  ? hosts.select(id)
                  : value === "Reconnect"
                    ? hosts.reconnect(id)
                    : value === "Disconnect"
                      ? hosts.disconnect(id)
                      : hosts.refresh(id),
              );
          }}
        />
      ) : (
        <Text>Connect to the selected host first. Esc returns to connections.</Text>
      )}
    </Box>
  );
}

function HostEditor({ host, onSave }: { host: Host; onSave: (host: Host) => void }) {
  const fields =
    host.kind === "local"
      ? ["label"]
      : host.kind === "wsl"
        ? ["label", "distribution", "user"]
        : ["label", "destination"];
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((key) => {
        const record = host as unknown as Record<string, unknown>;
        const value = record[key];
        if (value === null || value === undefined) return [key, ""];
        if (typeof value !== "string" && typeof value !== "number")
          throw new Error(`Invalid editor field ${key}`);
        return [key, String(value)];
      }),
    ),
  );
  const [error, setError] = useState<string>();
  const field = fields[index]!;
  return (
    <Box flexDirection="column">
      <Text
        bold
      >{`Edit ${host.kind.toUpperCase()} connection · ${index + 1}/${fields.length}`}</Text>
      <Text>{field}</Text>
      <TextInput
        key={field}
        defaultValue={values[field]!}
        onSubmit={(text) => {
          const next = { ...values, [field]: text.trim() };
          setValues(next);
          if (index < fields.length - 1) {
            setIndex(index + 1);
            return;
          }
          try {
            const common = { id: host.id, label: next["label"] };
            onSave(
              hostSchema.parse(
                host.kind === "local"
                  ? { ...common, kind: "local" }
                  : host.kind === "wsl"
                    ? {
                        ...common,
                        kind: "wsl",
                        distribution: next["distribution"],
                        user: next["user"] || null,
                      }
                    : {
                        ...common,
                        kind: "ssh",
                        destination: next["destination"],
                      },
              ),
            );
          } catch (cause) {
            setError(formatError(cause));
            setIndex(0);
          }
        }}
      />
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}

function ProviderAuth({ view, onError }: { view: TuiHostView; onError: (error: string) => void }) {
  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [provider, setProvider] = useState<ProviderStatus>();
  const [notice, setNotice] = useState<string>();
  const peer = view.harness!.client.peer;
  const pending = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState<{ url: string; userCode: string | null }>();
  useEffect(() => {
    const subscription = peer.onNotification(appAuthUrlNotification, setPrompt);
    return () => {
      pending.current?.abort();
      subscription.dispose();
    };
  }, [peer]);
  useInput((_input, key) => {
    if (key.escape) pending.current?.abort();
  });
  useEffect(() => {
    void peer
      .request(appProvidersRequest, {})
      .then(setProviders)
      .catch((cause: unknown) => onError(formatError(cause)));
  }, [peer, onError]);
  const login = (
    key: string | null,
    flow: "browser" | "device" = view.host.kind === "local" ? "browser" : "device",
  ) => {
    setNotice("Signing in (Esc cancels)");
    const abort = new AbortController();
    pending.current = abort;
    void peer
      .request(appAuthLoginRequest, { provider: provider!.id, key, flow }, { signal: abort.signal })
      .then(() => setNotice("Signed in; restart this host to use the provider."))
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        setNotice(undefined);
        onError(formatError(cause));
      })
      .finally(() => {
        pending.current = null;
        setPrompt(undefined);
      });
  };
  if (!providers) return <Spinner label="Reading host providers" />;
  if (!provider)
    return (
      <Select
        key="provider"
        options={providers.map((p) => ({
          label: `${p.label} · ${p.authenticated ? "signed in" : p.kind}`,
          value: p.id,
        }))}
        onChange={(id) => setProvider(providers.find((p) => p.id === id))}
      />
    );
  if (notice)
    return (
      <Box flexDirection="column">
        <Text>{notice}</Text>
        {prompt && (
          <>
            <Text>{`Open ${prompt.url}`}</Text>
            {prompt.userCode && <Text bold>{`Code: ${prompt.userCode}`}</Text>}
          </>
        )}
      </Box>
    );
  if (!provider.canStore)
    return <Text>Manage credentials through this host's configured environment or settings.</Text>;
  if (provider.authenticated)
    return (
      <Select
        key="signed-in"
        options={[
          { label: "Sign out", value: "logout" },
          { label: "Sign in again", value: "login" },
        ]}
        onChange={(action) => {
          if (action === "logout")
            void peer
              .request(appAuthLogoutRequest, { provider: provider.id })
              .then(() => setNotice("Signed out; restart the host."))
              .catch((cause: unknown) => onError(formatError(cause)));
          else setProvider({ ...provider, authenticated: false });
        }}
      />
    );
  if (provider.kind === "oauth" && view.host.kind === "local")
    return (
      <Select
        key="flow"
        options={[
          { label: "Browser sign-in", value: "browser" },
          { label: "Device code", value: "device" },
        ]}
        onChange={(flow) => login(null, flow as "browser" | "device")}
      />
    );
  if (provider.kind === "oauth")
    return <ConfirmInput onConfirm={() => login(null)} onCancel={() => setProvider(undefined)} />;
  return (
    <>
      <Text>{`API key for ${provider.label} on ${view.host.label}:`}</Text>
      <PasswordInput onSubmit={(key) => login(key)} />
    </>
  );
}

function HostSettings({ view, onError }: { view: TuiHostView; onError: (error: string) => void }) {
  const [initial, setInitial] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const peer = view.harness!.client.peer;
  useEffect(() => {
    void peer
      .request(appSettingsRequest, {})
      .then((result) => setInitial(JSON.stringify(result.settings)))
      .catch((cause: unknown) => onError(formatError(cause)));
  }, [peer, onError]);
  if (!initial) return <Spinner label="Reading selected host defaults" />;
  return (
    <>
      <Text>{`Edit defaults JSON for ${view.host.label}:`}</Text>
      <Text dimColor>
        compactionThresholdTokens: positive input-token count; null uses known model limits.
        worktreeDirectory: absolute server path; null uses ~/.harness/worktrees.
      </Text>
      <Text dimColor>
        toolMode: hybrid = Hybrid (essential tools direct, other tools through eval); code-only =
        Code only. showToolNames: include deferred tool names for the model (default true).
      </Text>
      <TextInput
        defaultValue={initial}
        onSubmit={(text) => {
          try {
            const value: unknown = JSON.parse(text);
            const settings = appSettingsUpdateRequest.params.parse(value);
            void peer
              .request(appSettingsUpdateRequest, settings)
              .then(() =>
                setNotice(
                  "Host defaults saved. Tool names apply to new or reloaded conversations. Restart the server to apply compaction changes to already-loaded conversations.",
                ),
              )
              .catch((cause: unknown) => onError(formatError(cause)));
          } catch (cause) {
            onError(formatError(cause));
          }
        }}
      />
      {notice && <Text>{notice}</Text>}
    </>
  );
}
