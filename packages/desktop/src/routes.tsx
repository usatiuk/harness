import { McpSettings } from "./components/mcp-settings.tsx";
import { DesktopUpdates } from "./components/desktop-updates.tsx";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createMemoryRouter,
  Form,
  Link,
  NavLink,
  Outlet,
  redirect,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteError,
  useRouteLoaderData,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
} from "react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { editPresentation } from "@harness/client-features/edit-presentation";
import type { Cell } from "@harness/client-features/transcript-reducer";
import { toolPermissionSchema, type ClientApproval } from "@harness/approval/client";
import { textOf, type Conversation, type ConversationId } from "@harness/protocol";
import {
  appAuthLogoutRequest,
  appSettingsUpdateRequest,
  type AppSettings,
} from "@harness/server/client-protocol";
import { DesktopSession, type ConversationView } from "./session.ts";
import {
  Button,
  Input,
  Select,
  Textarea,
  IconButton,
  PopoverControl,
  Confirmation,
  Disclosure,
  Tabs,
} from "./ui.tsx";
import { useComposerPreferences } from "./appearance.ts";
import { composerKey } from "./preferences.ts";
import { ContextUsage, LastTurnStats } from "./components/usage-inspector.tsx";
import { ConversationCanvas } from "./components/conversation-canvas.tsx";
import { AppearanceControls, ComposerSettings } from "./components/appearance-controls.tsx";
import {
  FolderOpen,
  Plus,
  Settings as SettingsIcon,
  Send,
  Square,
  ChevronDown,
  Settings2,
} from "lucide-react";

type ActionResult =
  | { ok: true; message?: string; restartRequired?: boolean }
  | { ok: false; message: string };
type RootData = { settings: AppSettings };
const modelKey = (provider: string, model: string): string => `${provider}\u0000${model}`;
const basename = (path: string | null): string =>
  path === null ? "Conversation" : (path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path);
const field = (data: FormData, name: string): string => {
  const value = data.get(name);
  if (typeof value !== "string") throw new Error(`Missing ${name}`);
  return value;
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const conversationLabel = (conversation: Conversation, view?: ConversationView): string => {
  const user = view?.state.cells.findLast((cell) => cell.kind === "user");
  return user?.kind === "user"
    ? user.text.split("\n")[0]!.slice(0, 64)
    : `${basename(conversation.workspaceRoot)} · ${new Date(conversation.createdAt).toLocaleString()}`;
};

export function createDesktopRouter(
  session: DesktopSession,
  connections: { controls: ReactNode; local: boolean; label: string; restart(): Promise<void> },
) {
  const useLive = (): void => {
    useSyncExternalStore(session.subscribe, session.snapshot);
  };

  async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
    try {
      const data = await request.formData();
      const intent = field(data, "intent");
      switch (intent) {
        case "approval": {
          const decision = field(data, "decision");
          if (decision !== "allow" && decision !== "deny")
            throw new Error("Invalid approval decision");
          await session.plugins.approvals.respond(field(data, "requestId"), decision);
          return { ok: true };
        }
        case "list-more":
          await session.list(true);
          return { ok: true };
        case "older":
          await session.older(field(data, "conversationId"));
          return { ok: true };
        case "send": {
          const id = field(data, "conversationId") as ConversationId;
          const delivery = field(data, "delivery");
          if (delivery !== "send" && delivery !== "queue" && delivery !== "steer")
            throw new Error("Invalid input delivery");
          const text = field(data, "text").trim();
          if (!text) throw new Error("Enter a message");
          try {
            await session.domain.deliver(id, text, delivery);
          } catch (error) {
            if (!session.client.peer.ready)
              throw new Error(
                "Connection lost. Delivery outcome is unknown; reconnect and check the conversation before sending again.",
                { cause: error },
              );
            throw error;
          }
          if (localStorage.getItem(session.storageKey(`draft:${id}`)) === field(data, "text"))
            localStorage.removeItem(session.storageKey(`draft:${id}`));
          return { ok: true };
        }
        case "stop":
          await session.domain.deliver(
            field(data, "conversationId") as ConversationId,
            "",
            "interrupt",
          );
          return { ok: true };
        case "model": {
          const [provider, model] = field(data, "model").split("\u0000");
          if (!provider || !model) throw new Error("Select a model");
          await session.domain.setModel(field(data, "conversationId") as ConversationId, {
            provider,
            model,
          });
          return { ok: true };
        }
        case "preset": {
          const id = field(data, "conversationId") as ConversationId;
          const view = await session.load(id);
          await session.domain.setPreset(
            id,
            view.conversation.config.model,
            field(data, "preset") || undefined,
          );
          return { ok: true };
        }
        case "sandbox": {
          const id = field(data, "conversationId") as ConversationId;
          const view = await session.load(id);
          if (view.state.turn.status === "running")
            throw new Error("Stop the running turn before changing sandbox");
          await session.domain.setPluginConfig(
            id,
            "sandbox",
            { backend: field(data, "sandbox") },
            { saveGlobal: true },
          );
          const result = await session.client.reload(id, true);
          if (result.status === "busy")
            throw new Error("Conversation became busy; stop it and apply the sandbox again");
          return { ok: true };
        }
        case "rebuild":
          await session.plugins.rebuildSandbox(field(data, "conversationId") as ConversationId);
          return { ok: true };
        case "sandbox-stop":
          await session.plugins.stopSandbox(field(data, "conversationId") as ConversationId);
          return { ok: true };
        case "activity-output": {
          const view = session.plugins.activities(field(data, "conversationId") as ConversationId);
          const content = await view.peek(field(data, "activityId"));
          return {
            ok: true,
            message: textOf(content),
          };
        }
        case "activity-kill":
          await session.plugins
            .activities(field(data, "conversationId") as ConversationId)
            .kill(field(data, "activityId"));
          return { ok: true };
        case "login": {
          await session.login(
            {
              provider: field(data, "provider"),
              key: data.has("key") ? field(data, "key") : null,
              flow: field(data, "flow"),
            },
            request.signal,
          );
          return {
            ok: true,
            restartRequired: true,
            message: "Signed in. Restart Harness to apply the provider.",
          };
        }
        case "logout":
          await session.client.peer.request(appAuthLogoutRequest, {
            provider: field(data, "provider"),
          });
          return {
            ok: true,
            restartRequired: true,
            message: "Stored credentials removed. Restart Harness to apply the change.",
          };
        case "settings": {
          const [provider, model] = field(data, "model").split("\u0000");
          const inWorkspace = field(data, "inWorkspace");
          const outOfWorkspace = field(data, "outOfWorkspace");
          const sandbox = field(data, "sandbox");
          const autoApproval = field(data, "autoApproval");
          const [reviewerProvider, reviewerModel] = field(data, "reviewerModel").split("\u0000");
          const reviewerPreset = reviewerModel ? field(data, "reviewerPreset") : "";
          if (
            ![inWorkspace, outOfWorkspace].every(
              (value) => toolPermissionSchema.safeParse(value).success,
            )
          )
            throw new Error("Invalid approval policy");
          if (sandbox !== "local" && sandbox !== "native" && sandbox !== "docker")
            throw new Error("Invalid sandbox");
          if (autoApproval !== "true" && autoApproval !== "false")
            throw new Error("Invalid auto approver setting");
          await session.client.peer.request(appSettingsUpdateRequest, {
            model:
              provider && model
                ? {
                    provider,
                    model,
                    preset:
                      session.settings?.settings.model?.provider === provider &&
                      session.settings.settings.model.model === model
                        ? session.settings.settings.model.preset
                        : null,
                  }
                : null,
            approval: {
              inWorkspace: toolPermissionSchema.parse(inWorkspace),
              outOfWorkspace: toolPermissionSchema.parse(outOfWorkspace),
              humanApprovalTimeoutSeconds: Number(field(data, "humanApprovalTimeoutSeconds")),
            },
            autoApproval: {
              enabled: autoApproval === "true",
              model:
                reviewerProvider && reviewerModel
                  ? {
                      provider: reviewerProvider,
                      model: reviewerModel,
                      preset: reviewerPreset || null,
                    }
                  : null,
            },
            sandbox,
          });
          return {
            ok: true,
            message: "Settings saved. The model and sandbox defaults apply to new conversations.",
          };
        }
        default:
          throw new Error(`Unknown action: ${String(intent)}`);
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  function ActionFeedback({ data }: { data: ActionResult | undefined }) {
    return data && "message" in data ? (
      <p role={data.ok ? "status" : "alert"} className={data.ok ? "muted" : "error"}>
        {data.message}
      </p>
    ) : null;
  }
  function RestartButton() {
    const returnFocus = useRef<HTMLDivElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [confirmRestart, setConfirmRestart] = useState(false);
    const running = [...session.views.values()].some(
      (view) =>
        view.state.turn.status === "running" ||
        session.plugins.runningActivities(view.conversation.id) > 0,
    );
    return (
      <div className="restart" ref={returnFocus} tabIndex={-1}>
        <p className="muted">
          Restart saves history and stops all conversations, commands and pending approvals.
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            if (running) {
              setConfirmRestart(true);
              return;
            }
            setBusy(true);
            void connections.restart().catch((cause: unknown) => {
              setError(errorMessage(cause));
              setBusy(false);
            });
          }}
        >
          {busy ? "Restarting…" : "Restart Harness"}
        </Button>
        <Confirmation
          acceptedFocusRef={returnFocus}
          open={confirmRestart}
          onOpenChange={setConfirmRestart}
          title="Restart Harness?"
          description="Restart saves history and stops all conversations, commands and pending approvals."
          confirmLabel="Restart Harness"
          onConfirm={() => {
            setBusy(true);
            void connections.restart().catch((cause: unknown) => {
              setError(errorMessage(cause));
              setBusy(false);
            });
          }}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  }
  function Approval({ approval }: { approval: ClientApproval }) {
    const fetcher = useFetcher<ActionResult>();
    return (
      <section className="approval" aria-label="Approval request">
        <strong>Allow {approval.call.name}?</strong>
        {approval.relationship && <span className="muted">{approval.relationship}</span>}
        <pre>
          {typeof approval.call.args === "string"
            ? approval.call.args
            : JSON.stringify(approval.call.args, null, 2)}
        </pre>
        <fetcher.Form method="post" action="/actions" className="button-row">
          <Input type="hidden" name="intent" value="approval" />
          <Input type="hidden" name="requestId" value={approval.requestId} />
          <Button type="submit" name="decision" value="deny" disabled={fetcher.state !== "idle"}>
            Deny
          </Button>
          <Button
            type="submit"
            variant="accent"
            name="decision"
            value="allow"
            disabled={fetcher.state !== "idle"}
          >
            Allow
          </Button>
        </fetcher.Form>
        <ActionFeedback data={fetcher.data} />
      </section>
    );
  }
  function Layout() {
    useLive();
    const navigation = useNavigation();
    const more = useFetcher<ActionResult>();
    return (
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-heading">
            {connections.controls}
            <Link
              to="/new"
              className="new-conversation"
              aria-label="New conversation"
              title="New conversation"
            >
              <Plus size={15} aria-hidden="true" />
            </Link>
          </div>
          <nav aria-label="Conversations" className="conversation-list">
            {session.conversations.map((conversation) => {
              const view = session.views.get(conversation.id);
              const status = view?.approvals.size
                ? "Approval needed"
                : view?.state.turn.status === "running"
                  ? "Running"
                  : view?.state.turn.status === "failed"
                    ? "Failed"
                    : "";
              return (
                <NavLink
                  key={conversation.id}
                  to={`/conversations/${conversation.id}`}
                  title={conversation.workspaceRoot ?? undefined}
                >
                  <span className="conversation-title">
                    {conversationLabel(conversation, view)}
                  </span>
                  {status && (
                    <span
                      className={`conversation-status-mark ${view?.approvals.size ? "approval-status" : view?.state.turn.status === "failed" ? "failed-status" : ""}`}
                      aria-label={status}
                      title={status}
                    />
                  )}
                </NavLink>
              );
            })}
            {session.listCursor && (
              <more.Form method="post" action="/actions">
                <Input type="hidden" name="intent" value="list-more" />
                <Button type="submit" disabled={more.state !== "idle"}>
                  Load more
                </Button>
              </more.Form>
            )}
            <ActionFeedback data={more.data} />
          </nav>
          <NavLink to="/settings" className="settings-link">
            <SettingsIcon size={15} aria-hidden="true" /> Settings
          </NavLink>
        </aside>
        <main>
          {session.disconnected && (
            <div className="connection-error" role="alert">
              <strong>{session.disconnected}</strong>
              <RestartButton />
            </div>
          )}
          {navigation.state === "loading" && (
            <div className="navigation-status" role="status">
              Loading conversation…
            </div>
          )}
          {navigation.state === "loading" &&
            [...session.views.values()].flatMap((view) =>
              [...view.approvals.values()].map((approval) => (
                <Approval key={approval.requestId} approval={approval} />
              )),
            )}
          <Outlet />
        </main>
      </div>
    );
  }
  function Welcome() {
    return (
      <div className="welcome">
        <h1>Start a conversation</h1>
        <p>
          Select a folder and a model to begin. Your conversations stay available in the sidebar.
        </p>
        <Link to="/new" className="new-conversation">
          New conversation
        </Link>
        <Link to="/settings">Connect a provider</Link>
      </div>
    );
  }
  function ModelOptions({ selected }: { selected?: { provider: string; model: string } }) {
    const models = session.domain.availableModels();
    const unavailable =
      selected &&
      !models.some(
        (model) => model.provider === selected.provider && model.model === selected.model,
      );
    return (
      <>
        {unavailable && (
          <option value={modelKey(selected.provider, selected.model)}>
            {session.settings?.providers.find((provider) => provider.id === selected.provider)
              ?.label ?? selected.provider}{" "}
            / {selected.model} — unavailable;{" "}
            {session.settings?.providers.find((provider) => provider.id === selected.provider)
              ?.catalog ?? "check provider configuration"}
          </option>
        )}
        {models.map((model) => (
          <option
            key={modelKey(model.provider, model.model)}
            value={modelKey(model.provider, model.model)}
          >
            {session.settings?.providers.find((provider) => provider.id === model.provider)
              ?.label ?? model.provider}{" "}
            / {model.label ?? model.model}
            {[
              ...(model.contextWindow ? [`${model.contextWindow.toLocaleString()} context`] : []),
              ...(model.maxInputTokens ? [`${model.maxInputTokens.toLocaleString()} input`] : []),
              ...(model.maxOutputTokens
                ? [`${model.maxOutputTokens.toLocaleString()} output`]
                : []),
              ...(model.reasoning?.supported === true ? ["reasoning"] : []),
            ]
              .map((detail) => ` · ${detail}`)
              .join("")}
          </option>
        ))}
      </>
    );
  }
  function SandboxOptions({ selected }: { selected?: string }) {
    return (
      <>
        <option value="local">Local</option>
        {session.settings?.platform === "linux" && <option value="native">Native</option>}
        {session.settings?.platform !== "linux" && selected === "native" && (
          <option value="native">Native (Linux only)</option>
        )}
        <option value="docker">Docker / devcontainer</option>
      </>
    );
  }
  function NewConversation() {
    const { settings } = useRouteLoaderData<RootData>("app")!;
    const [cwd, setCwd] = useState(
      localStorage.getItem(session.storageKey("last-directory")) ?? settings.cwd,
    );
    const navigation = useNavigation();
    const defaultModel = settings.settings.model ?? session.domain.defaultModel();
    const [selection, setSelection] = useState(modelKey(defaultModel.provider, defaultModel.model));
    const [backend, setBackend] = useState<string>(settings.settings.sandbox);
    const [toolMode, setToolMode] = useState("direct");
    const backendAvailable = backend !== "native" || settings.platform === "linux";
    const available = session.domain
      .availableModels()
      .some((model) => modelKey(model.provider, model.model) === selection);
    const [error, setError] = useState<string>();
    return (
      <section className="page new-page">
        <div className="page-heading">
          <h1>New conversation</h1>
        </div>
        <p className="page-lead">
          Choose a project folder to give your conversation a place to work.
        </p>
        <Form method="post" className="creation-form">
          <div className="folder-field">
            <label>
              Project folder
              <Input
                name="cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                required
              />
            </label>
            {connections.local && (
              <Button
                type="button"
                onClick={() => {
                  void open({ directory: true, multiple: false, title: "Choose project folder" })
                    .then((path) => {
                      if (typeof path === "string") setCwd(path);
                    })
                    .catch((cause: unknown) => setError(errorMessage(cause)));
                }}
              >
                <FolderOpen size={15} aria-hidden="true" /> Choose folder…
              </Button>
            )}
            {!connections.local && (
              <p className="muted">Enter a project path on {connections.label}.</p>
            )}
          </div>
          <Input type="hidden" name="model" value={selection} />
          <Input type="hidden" name="sandbox" value={backend} />
          <Input type="hidden" name="toolMode" value={toolMode} />
          <div className="creation-footer">
            <div className="creation-options">
              <PopoverControl
                label="New conversation model"
                align="start"
                trigger={
                  <Button variant="ghost" size="sm" aria-label="Choose model">
                    <span>
                      {session.domain
                        .availableModels()
                        .find((model) => modelKey(model.provider, model.model) === selection)
                        ?.label ?? selection.split("\u0000")[1]}
                    </span>
                    <ChevronDown size={12} aria-hidden="true" />
                  </Button>
                }
              >
                <label>
                  Model
                  <Select value={selection} onChange={(event) => setSelection(event.target.value)}>
                    <ModelOptions selected={defaultModel} />
                  </Select>
                </label>
              </PopoverControl>
              <PopoverControl
                label="New conversation execution"
                align="start"
                trigger={
                  <Button variant="ghost" size="sm" aria-label="Choose execution options">
                    {backend === "docker" ? "Docker" : backend === "native" ? "Native" : "Local"}
                    <ChevronDown size={12} aria-hidden="true" />
                  </Button>
                }
              >
                <div className="form-grid">
                  <label>
                    Sandbox
                    <Select value={backend} onChange={(event) => setBackend(event.target.value)}>
                      <SandboxOptions selected={backend} />
                    </Select>
                  </label>
                  <label>
                    Tool interface
                    <Select value={toolMode} onChange={(event) => setToolMode(event.target.value)}>
                      <option value="direct">Direct</option>
                      <option value="hybrid">Direct and code</option>
                      <option value="code-only">Code only</option>
                    </Select>
                  </label>
                </div>
              </PopoverControl>
            </div>
            <Button
              type="submit"
              variant="accent"
              disabled={
                !available ||
                !backendAvailable ||
                navigation.state !== "idle" ||
                Boolean(session.disconnected)
              }
            >
              {navigation.state !== "idle" ? "Creating…" : "Create conversation"}
            </Button>
          </div>
        </Form>
        {!available && (
          <p role="status" className="muted">
            The selected model is unavailable in this server. Restart after connecting its provider,
            or select an available model.
          </p>
        )}
        {!backendAvailable && (
          <p role="status" className="muted">
            Native sandbox requires Linux. Select Local or Docker to continue.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {backend === "docker" && (
          <p className="muted">Docker uses this folder’s devcontainer configuration.</p>
        )}
      </section>
    );
  }

  function ConversationControls({ view }: { view: ConversationView }) {
    const model = useFetcher<ActionResult>();
    const preset = useFetcher<ActionResult>();
    const sandbox = useFetcher<ActionResult>();
    const control = useFetcher<ActionResult>();
    const [pendingSandbox, setPendingSandbox] = useState<FormData>();
    const sandboxTrigger = useRef<HTMLButtonElement>(null);
    const id = view.conversation.id;
    const selected = view.conversation.config.model;
    const catalog = session.domain
      .availableModels()
      .find((entry) => entry.provider === selected.provider && entry.model === selected.model);
    const presets = catalog?.presets ?? [];
    const backend =
      (view.conversation.config.plugins?.["sandbox"] as { backend?: string } | undefined)
        ?.backend ?? "local";
    const running = view.state.turn.status === "running";
    const disabled = Boolean(session.disconnected);
    return (
      <>
        <div className="conversation-controls">
          <PopoverControl
            label="Model and preset"
            align="start"
            trigger={
              <Button
                variant="ghost"
                className="composer-chip"
                aria-label={`Model and preset: ${catalog?.label ?? selected.model}${selected.preset ? ` · ${selected.preset}` : ""}`}
              >
                <span>
                  {catalog?.label ?? selected.model}
                  {selected.preset
                    ? ` · ${presets.find((entry) => entry.value === selected.preset)?.label ?? selected.preset}`
                    : ""}
                </span>
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            }
          >
            <h3>Model and preset</h3>
            <model.Form method="post" action="/actions" className="picker-form">
              <Input type="hidden" name="intent" value="model" />
              <Input type="hidden" name="conversationId" value={id} />
              <label>
                Model
                <Select
                  aria-label="Conversation model"
                  name="model"
                  value={modelKey(selected.provider, selected.model)}
                  disabled={disabled || model.state !== "idle"}
                  onChange={(event) => {
                    void model.submit(event.currentTarget.form);
                  }}
                >
                  <ModelOptions selected={selected} />
                </Select>
              </label>
            </model.Form>
            {(presets.length > 0 || selected.preset) && (
              <preset.Form method="post" action="/actions" className="picker-form">
                <Input type="hidden" name="intent" value="preset" />
                <Input type="hidden" name="conversationId" value={id} />
                <label>
                  Preset
                  <Select
                    aria-label="Conversation preset"
                    name="preset"
                    value={selected.preset ?? ""}
                    disabled={disabled || preset.state !== "idle"}
                    onChange={(event) => {
                      void preset.submit(event.currentTarget.form);
                    }}
                  >
                    <option value="">Default</option>
                    {selected.preset &&
                      !presets.some((entry) => entry.value === selected.preset) && (
                        <option value={selected.preset}>{selected.preset} — unavailable</option>
                      )}
                    {presets.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label ?? entry.value}
                      </option>
                    ))}
                  </Select>
                </label>
              </preset.Form>
            )}
            <p className="muted">
              {catalog?.contextWindow
                ? `${catalog.contextWindow.toLocaleString()} context`
                : "Context capacity unknown"}
              {catalog?.reasoning?.supported ? " · Reasoning supported" : ""}
            </p>
            <ActionFeedback data={model.data} />
            <ActionFeedback data={preset.data} />
          </PopoverControl>
          <PopoverControl
            label="Sandbox controls"
            align="start"
            trigger={
              <Button
                ref={sandboxTrigger}
                variant="ghost"
                className="composer-chip"
                aria-label={`Sandbox: ${backend}`}
              >
                {backend === "docker" ? "Docker" : backend === "native" ? "Native" : "Local"}
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            }
          >
            <h3>Execution sandbox</h3>
            <sandbox.Form method="post" action="/actions" className="picker-form">
              <Input type="hidden" name="intent" value="sandbox" />
              <Input type="hidden" name="conversationId" value={id} />
              <label>
                Sandbox
                <Select
                  aria-label="Conversation sandbox"
                  name="sandbox"
                  value={backend}
                  disabled={running || disabled || sandbox.state !== "idle"}
                  onChange={(event) => {
                    const data = new FormData(event.currentTarget.form!);
                    if (session.plugins.runningActivities(id) > 0) setPendingSandbox(data);
                    else void sandbox.submit(data, { method: "post", action: "/actions" });
                  }}
                >
                  <SandboxOptions selected={backend} />
                </Select>
              </label>
            </sandbox.Form>
            {running && <p className="muted">Stop the running turn before changing sandbox.</p>}
            {backend === "docker" && (
              <control.Form method="post" action="/actions" className="picker-form">
                <Input type="hidden" name="conversationId" value={id} />
                <div className="button-row">
                  <Button
                    type="submit"
                    name="intent"
                    value="rebuild"
                    disabled={disabled || control.state !== "idle"}
                  >
                    Rebuild
                  </Button>
                  <Button
                    type="submit"
                    variant="danger"
                    name="intent"
                    value="sandbox-stop"
                    disabled={disabled || control.state !== "idle"}
                  >
                    Stop container
                  </Button>
                </div>
                <p className="muted">Affects conversations sharing this container.</p>
              </control.Form>
            )}
            <ActionFeedback data={sandbox.data} />
            <ActionFeedback data={control.data} />
          </PopoverControl>
        </div>
        <Confirmation
          returnFocusRef={sandboxTrigger}
          open={Boolean(pendingSandbox)}
          onOpenChange={(open) => {
            if (!open) setPendingSandbox(undefined);
          }}
          title="Change sandbox?"
          description="Changing sandbox stops this conversation’s background work."
          confirmLabel="Change sandbox"
          onConfirm={() => {
            if (!pendingSandbox) throw new Error("Missing sandbox confirmation intent");
            void sandbox.submit(pendingSandbox, { method: "post", action: "/actions" });
          }}
        />
        <div className="control-feedback">
          <ActionFeedback data={model.data?.ok === false ? model.data : undefined} />
          <ActionFeedback data={preset.data?.ok === false ? preset.data : undefined} />
          <ActionFeedback data={sandbox.data?.ok === false ? sandbox.data : undefined} />
          <ActionFeedback data={control.data?.ok === false ? control.data : undefined} />
        </div>
      </>
    );
  }

  function TranscriptCell({ cell, children = [] }: { cell: Cell; children?: Cell[] | undefined }) {
    if (cell.kind === "tool") {
      const edit = editPresentation(cell);
      return (
        <Disclosure
          className={`cell tool ${cell.status === "error" ? "failed" : ""}`}
          data-testid="tool-call"
          title={
            <>
              <strong>
                {edit
                  ? cell.status === "ok"
                    ? edit.labels.succeeded
                    : cell.status === "error"
                      ? edit.labels.failed
                      : edit.labels.running
                  : cell.name}
              </strong>
              <span className="muted">
                {cell.approvalProgress?.status === "reviewing"
                  ? "awaiting approval"
                  : (cell.status ?? "running")}
              </span>
              {children.length > 0 && (
                <span className="muted">{children.length} nested operations</span>
              )}
            </>
          }
        >
          {cell.parentCallId && <p className="muted">Invoked by {cell.parentCallId}</p>}
          {children.length > 0 && (
            <div className="nested-tools">
              {children.map((child) => (
                <TranscriptCell key={child.kind === "tool" ? child.callId : ""} cell={child} />
              ))}
            </div>
          )}
          {edit &&
            edit.files.map((file, index) => (
              <section className="diff" key={`${file.path}:${index}`}>
                <strong>{file.path}</strong>
                <pre>
                  {file.lines.map((line, lineIndex) => (
                    <span key={lineIndex} className={`diff-${line.kind}`}>
                      {line.text}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </section>
            ))}
          <h3>Arguments</h3>
          <pre>
            {typeof cell.args === "string" ? cell.args : JSON.stringify(cell.args, null, 2)}
          </pre>
          <h3>Output</h3>
          <pre data-testid="tool-output">{cell.output ?? "Waiting for output…"}</pre>
          {cell.approval && (
            <p className="muted">
              {cell.approval.decision === "allow" ? "Allowed" : "Denied"} by{" "}
              {cell.approval.responder}
            </p>
          )}
        </Disclosure>
      );
    }
    if (cell.kind === "reasoning")
      return (
        <Disclosure className="cell reasoning" title={<>Reasoning {cell.streaming ? "…" : ""}</>}>
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
            {cell.text}
          </Markdown>
        </Disclosure>
      );
    if (cell.kind === "compaction" || cell.kind === "context")
      return (
        <Disclosure
          className="cell"
          title={<>{cell.kind === "compaction" ? "Compacted context" : "Context"}</>}
        >
          <pre>{cell.text}</pre>
        </Disclosure>
      );
    if (cell.kind === "worked")
      return <div className="cell muted">Worked for {Math.round(cell.duration / 1000)}s</div>;
    if (cell.kind === "user")
      return (
        <article className="cell user">
          <div className="user-text">{cell.text}</div>
        </article>
      );
    if (cell.kind === "assistant")
      return (
        <article
          className="cell assistant"
          data-testid="assistant-message"
          data-phase={cell.phase ?? undefined}
        >
          {cell.phase && cell.phase !== "final_answer" && <div className="muted">{cell.phase}</div>}
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
            {cell.text}
          </Markdown>
          {cell.streaming && <span className="stream-indicator" aria-label="Streaming" />}
        </article>
      );
    if (cell.kind === "error")
      return (
        <div className="cell error" role="alert">
          {cell.text}
        </div>
      );
    if (cell.kind === "shell")
      return (
        <Disclosure className="cell" title={<>{cell.command}</>}>
          <pre>{cell.text}</pre>
        </Disclosure>
      );
    return <div className="cell muted">{cell.text}</div>;
  }
  function TranscriptLink({
    href,
    children,
  }: {
    href?: string | undefined;
    children?: React.ReactNode;
  }) {
    const [error, setError] = useState<string>();
    const browserUrl = href && /^https?:\/\//u.test(href) ? href : undefined;
    return (
      <>
        <a
          href={browserUrl}
          onClick={(event) => {
            event.preventDefault();
            if (browserUrl)
              void openUrl(browserUrl).catch((cause: unknown) => setError(errorMessage(cause)));
          }}
        >
          {children}
        </a>
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
      </>
    );
  }
  function Activity({
    view,
    id,
    title,
    running,
  }: {
    view: ConversationView;
    id: string;
    title: string;
    running: boolean;
  }) {
    const output = useFetcher<ActionResult>();
    const kill = useFetcher<ActionResult>();
    return (
      <Disclosure
        className="activity"
        title={
          <>
            {title} · {running ? "running" : "finished"}
          </>
        }
      >
        <output.Form method="post" action="/actions">
          <Input type="hidden" name="conversationId" value={view.conversation.id} />
          <Input type="hidden" name="activityId" value={id} />
          <Button
            type="submit"
            name="intent"
            value="activity-output"
            disabled={output.state !== "idle"}
          >
            Refresh output
          </Button>
        </output.Form>
        {output.data?.ok && output.data.message && <pre>{output.data.message}</pre>}
        {output.data && !output.data.ok && <ActionFeedback data={output.data} />}
        {running && (
          <kill.Form method="post" action="/actions">
            <Input type="hidden" name="conversationId" value={view.conversation.id} />
            <Input type="hidden" name="activityId" value={id} />
            <Button
              type="submit"
              name="intent"
              value="activity-kill"
              disabled={kill.state !== "idle"}
            >
              Stop activity
            </Button>
          </kill.Form>
        )}
      </Disclosure>
    );
  }
  function Composer({ view }: { view: ConversationView }) {
    const send = useFetcher<ActionResult>();
    const stop = useFetcher<ActionResult>();
    const id = view.conversation.id;
    const [text, setText] = useState(localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const handled = useRef<ActionResult | undefined>(undefined);
    const running = view.state.turn.status === "running";
    const preferences = useComposerPreferences();
    const defaultDelivery = running ? "steer" : "send";
    const busy = send.state !== "idle" || stop.state !== "idle";
    const disabled = !text.trim() || busy || Boolean(session.disconnected);
    const stopping = running && !text.trim();
    useEffect(() => {
      if (send.state === "idle" && send.data?.ok && handled.current !== send.data) {
        handled.current = send.data;
        setText(localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "");
        textarea.current?.focus();
      }
    }, [send.state, send.data, id]);
    const submit = (delivery: "send" | "queue" | "steer") => {
      if (disabled) return;
      const data = new FormData();
      data.set("intent", "send");
      data.set("conversationId", id);
      data.set("text", text);
      data.set("delivery", delivery);
      void send.submit(data, { method: "post", action: "/actions" });
    };
    const interrupt = () => {
      if (!running || stop.state !== "idle" || session.disconnected) return;
      const data = new FormData();
      data.set("intent", "stop");
      data.set("conversationId", id);
      void stop.submit(data, { method: "post", action: "/actions" });
    };
    return (
      <div className="composer-wrap">
        <div className="conversation-status">
          <span role="status">
            {view.approvals.size ? "Waiting for approval" : running ? "Working…" : "Ready"}
          </span>
          {preferences.showStats && <LastTurnStats state={view.state} />}
        </div>
        <div className="composer">
          {view.state.pendingInput.length > 0 && (
            <div className="pending-input">
              {view.state.pendingInput.map((input, index) => (
                <div key={index}>
                  {input.intent}: {input.text}
                </div>
              ))}
            </div>
          )}
          <send.Form
            method="post"
            action="/actions"
            onSubmit={(event) => {
              event.preventDefault();
              submit(defaultDelivery);
            }}
          >
            <Input type="hidden" name="intent" value="send" />
            <Input type="hidden" name="conversationId" value={id} />
            <Input type="hidden" name="delivery" value={defaultDelivery} />
            <Textarea
              ref={textarea}
              name="text"
              aria-label="Message"
              placeholder="Ask a follow-up…"
              value={text}
              rows={2}
              onChange={(event) => {
                setText(event.target.value);
                localStorage.setItem(session.storageKey(`draft:${id}`), event.target.value);
              }}
              onKeyDown={(event) => {
                const action = composerKey(
                  {
                    ...event,
                    isComposing: event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229,
                  },
                  preferences,
                  running,
                );
                if (!action || action === "newline") return;
                event.preventDefault();
                if (action === "interrupt") interrupt();
                else submit(action);
              }}
            />
          </send.Form>
          <div className="composer-actions">
            <ConversationControls view={view} />
            <PopoverControl
              label="Composer settings"
              trigger={<IconButton label="Composer settings" icon={Settings2} />}
            >
              <h3>Composer settings</h3>
              <ComposerSettings />
            </PopoverControl>
            <div className="composer-send">
              <ContextUsage state={view.state} models={session.domain.availableModels()} />
              <Button
                variant="accent"
                size="sm"
                className="composer-primary"
                disabled={
                  stopping ? stop.state !== "idle" || Boolean(session.disconnected) : disabled
                }
                onClick={() => (stopping ? interrupt() : submit(defaultDelivery))}
              >
                {stopping || stop.state !== "idle" ? (
                  <Square size={12} aria-hidden="true" />
                ) : (
                  <Send size={14} aria-hidden="true" />
                )}
                {stop.state !== "idle"
                  ? "Stopping…"
                  : send.state !== "idle" && !stopping
                    ? "Sending…"
                    : stopping
                      ? "Stop"
                      : running
                        ? "Steer"
                        : "Send"}
              </Button>
            </div>
          </div>
          <ActionFeedback data={send.data} />
          <ActionFeedback data={stop.data} />
        </div>
        <small className="composer-hint">
          {preferences.sendWith} {running ? "steer" : "send"} ·{" "}
          {preferences.sendWith === "Enter" ? "Shift+Enter" : "Enter"} newline
          {running ? " · Ctrl/⌘+Enter queue · Ctrl/⌘+. stop" : ""}
        </small>
      </div>
    );
  }

  function ConversationPage() {
    useLive();
    const view = useLoaderData<ConversationView>();
    const older = useFetcher<ActionResult>();
    return (
      <ConversationCanvas
        key={view.conversation.id}
        rows={view.transcript.rows}
        running={view.state.turn.status === "running"}
        header={
          <header className="conversation-header">
            <div className="conversation-heading">
              <h1>{conversationLabel(view.conversation, view)}</h1>
              <div className="workspace-path" title={view.conversation.workspaceRoot ?? undefined}>
                {view.conversation.workspaceRoot}
              </div>
            </div>
          </header>
        }
        history={
          view.cursor ? (
            <older.Form method="post" action="/actions">
              <Input type="hidden" name="intent" value="older" />
              <Input type="hidden" name="conversationId" value={view.conversation.id} />
              <Button type="submit" disabled={older.state !== "idle"}>
                Load earlier messages
              </Button>
              <ActionFeedback data={older.data} />
            </older.Form>
          ) : null
        }
        renderRow={({ cell, children }) => <TranscriptCell cell={cell} children={children} />}
        dock={
          <>
            <div className="conversation-support">
              {view.state.sandbox?.message && (
                <p
                  role="status"
                  className={
                    view.state.sandbox.phase === "error"
                      ? "error sandbox-status"
                      : "sandbox-status muted"
                  }
                >
                  {view.state.sandbox.message}
                </p>
              )}
              {view.state.activities.length > 0 && (
                <Disclosure
                  className="activities"
                  title={
                    <>
                      Activities (
                      {
                        view.state.activities.filter((activity) => activity.status === undefined)
                          .length
                      }{" "}
                      running)
                    </>
                  }
                >
                  {view.state.activities.map((activity) => (
                    <Activity
                      key={activity.id}
                      view={view}
                      id={activity.id}
                      title={activity.title}
                      running={activity.status === undefined}
                    />
                  ))}
                </Disclosure>
              )}
              <div className="approvals">
                {[...view.approvals.values()].map((approval) => (
                  <Approval key={approval.requestId} approval={approval} />
                ))}
              </div>
            </div>
            <Composer key={view.conversation.id} view={view} />
          </>
        }
      />
    );
  }

  function Provider({ provider }: { provider: AppSettings["providers"][number] }) {
    const fetcher = useFetcher<ActionResult>();
    const submitKey = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void fetcher.submit(data, { method: "post", action: "/actions" });
      event.currentTarget.reset();
    };
    return (
      <section className="provider">
        <div className="provider-summary">
          <h3>{provider.label}</h3>
          <p className="muted">
            {provider.authenticated
              ? `Credentials available${provider.detail ? ` · ${provider.detail}` : ""}`
              : "No credentials"}
          </p>
        </div>
        <Disclosure title="Connection details" className="provider-details">
          <p className="muted">
            {provider.id} · {provider.type} · {provider.catalog} · {provider.modelCount} models
          </p>
          {provider.diagnostics.map((diagnostic, index) => (
            <p className="muted" key={index}>
              {diagnostic}
            </p>
          ))}
        </Disclosure>
        {provider.canStore && (
          <fetcher.Form
            method="post"
            action="/actions"
            {...(provider.kind === "api-key" ? { onSubmit: submitKey } : {})}
            className="button-row"
          >
            <Input type="hidden" name="intent" value="login" />
            <Input type="hidden" name="provider" value={provider.id} />
            {provider.kind === "oauth" && connections.local ? (
              <label>
                Sign-in method
                <Select name="flow" defaultValue="browser">
                  <option value="browser">Browser sign-in</option>
                  <option value="device">Device code</option>
                </Select>
              </label>
            ) : (
              <Input
                type="hidden"
                name="flow"
                value={provider.kind === "oauth" ? "device" : "browser"}
              />
            )}

            {provider.kind === "api-key" && (
              <label>
                API key
                <Input
                  name="key"
                  type="password"
                  autoComplete="off"
                  required
                  aria-label={`${provider.label} API key`}
                />
              </label>
            )}
            <Button type="submit" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle"
                ? "Connecting…"
                : provider.kind === "oauth"
                  ? connections.local
                    ? "Sign in"
                    : "Sign in with device code"
                  : "Save key"}
            </Button>
          </fetcher.Form>
        )}
        {!provider.canStore && provider.kind === "api-key" && (
          <p className="muted">
            Manage this connection through its configured environment variable and restart Harness.
          </p>
        )}
        {provider.authenticated && provider.canStore && (
          <fetcher.Form method="post" action="/actions">
            <Input type="hidden" name="intent" value="logout" />
            <Input type="hidden" name="provider" value={provider.id} />
            <Button type="submit" disabled={fetcher.state !== "idle"}>
              Disconnect stored credentials
            </Button>
          </fetcher.Form>
        )}
        <ActionFeedback data={fetcher.data} />
        {fetcher.data?.ok && fetcher.data.restartRequired && <RestartButton />}
      </section>
    );
  }
  function Settings() {
    useLive();
    const { settings } = useRouteLoaderData<RootData>("app")!;
    const save = useFetcher<ActionResult>();
    const [search, setSearch] = useSearchParams();
    const sections = [
      "Appearance",
      "Composer",
      "Defaults",
      "Providers",
      "MCP",
      "Application",
    ] as const;
    const requested = search.get("section");
    const section =
      sections.find((label) => label.toLowerCase() === requested)?.toLowerCase() ?? "appearance";
    const selected = settings.settings.model ?? session.domain.defaultModel();
    return (
      <section className="page settings-page">
        <div className="page-heading">
          <h1>Settings</h1>
        </div>
        <Tabs.Root
          value={section}
          onValueChange={(section) => {
            void setSearch({ section }, { replace: true });
          }}
          className="settings-sections"
        >
          <Tabs.List aria-label="Settings sections" className="settings-section-nav">
            {sections.map((label) => (
              <Tabs.Trigger key={label} value={label.toLowerCase()} className="settings-tab">
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="appearance" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Appearance</h2>
              <p className="muted">Make this app feel like yours.</p>
            </div>
            <AppearanceControls />
          </Tabs.Content>
          <Tabs.Content value="composer" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Composer</h2>
              <p className="muted">Keyboard shortcuts and optional turn statistics.</p>
            </div>
            <ComposerSettings />
          </Tabs.Content>
          <Tabs.Content value="defaults" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Conversation defaults</h2>
              <p className="muted">Used for new conversations on {connections.label}.</p>
            </div>
            <save.Form method="post" action="/actions" className="form-grid">
              <Input type="hidden" name="intent" value="settings" />
              <label>
                Model for new conversations
                <Select
                  name="model"
                  key={modelKey(selected.provider, selected.model)}
                  defaultValue={modelKey(selected.provider, selected.model)}
                >
                  <ModelOptions selected={selected} />
                </Select>
              </label>
              <label>
                Sandbox for new conversations
                <Select name="sandbox" defaultValue={settings.settings.sandbox}>
                  <SandboxOptions selected={settings.settings.sandbox} />
                </Select>
              </label>
              <label>
                Tools inside the workspace
                <Select name="inWorkspace" defaultValue={settings.settings.approval.inWorkspace}>
                  <option value="allow">Allow</option>
                  <option value="ask">Ask</option>
                  <option value="ask-human">Ask human</option>
                  <option value="deny">Deny</option>
                </Select>
              </label>
              <label>
                Tools outside or with unknown scope
                <Select
                  name="outOfWorkspace"
                  defaultValue={settings.settings.approval.outOfWorkspace}
                >
                  <option value="allow">Allow</option>
                  <option value="ask">Ask</option>
                  <option value="ask-human">Ask human</option>
                  <option value="deny">Deny</option>
                </Select>
              </label>
              <label>
                Human approval timeout (seconds)
                <Input
                  name="humanApprovalTimeoutSeconds"
                  type="number"
                  min="0.001"
                  max="2147483"
                  step="any"
                  defaultValue={settings.settings.approval.humanApprovalTimeoutSeconds}
                  required
                />
              </label>
              <label>
                Auto approver
                <Select
                  name="autoApproval"
                  defaultValue={String(settings.settings.autoApproval.enabled)}
                >
                  <option value="false">Off</option>
                  <option value="true">On</option>
                </Select>
              </label>
              <ReviewerFields
                key={JSON.stringify(settings.settings.autoApproval.model)}
                model={settings.settings.autoApproval.model}
              />
              <Button
                type="submit"
                variant="accent"
                disabled={save.state !== "idle" || Boolean(session.disconnected)}
              >
                Save defaults
              </Button>
            </save.Form>
            <p className="muted">
              Auto-review settings apply to open and new conversations. If no reviewer model is
              selected, each review uses the conversation’s model.
            </p>
            <ActionFeedback data={save.data} />
          </Tabs.Content>
          <Tabs.Content value="mcp" forceMount className="settings-panel">
            <h2>MCP servers</h2>
            <McpSettings
              client={session.client}
              openUrl={openUrl}
              restart={() => connections.restart()}
            />
          </Tabs.Content>
          <Tabs.Content value="providers" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Providers</h2>
              <p className="muted">
                Credentials use Harness’s existing credential store. Provider changes take effect
                after a restart.
              </p>
            </div>
            {settings.providers.map((provider) => (
              <Provider key={provider.id} provider={provider} />
            ))}
            {session.authUrl && (
              <div className="auth-url">
                <p>
                  {session.authCode
                    ? "Open this URL in your browser and enter the one-time code:"
                    : "Complete sign-in in your browser. If it did not open, copy this URL:"}
                </p>
                <Input
                  readOnly
                  value={session.authUrl}
                  aria-label="Sign-in URL"
                  onFocus={(event) => event.currentTarget.select()}
                />
                {session.authCode && (
                  <Input
                    readOnly
                    value={session.authCode}
                    aria-label="Sign-in code"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                )}
                <div className="button-row">
                  <Button onClick={() => void openUrl(session.authUrl!)}>Open sign-in page</Button>
                  <Button onClick={() => session.cancelLogin()}>Cancel sign-in</Button>
                </div>
              </div>
            )}
          </Tabs.Content>
          <Tabs.Content value="application" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Application</h2>
              <p className="muted">Server lifecycle and local storage.</p>
            </div>
            <DesktopUpdates />
            <div className="storage-location">
              <h3>Harness home</h3>
              <p className="muted">{settings.home}</p>
            </div>
            <RestartButton />
          </Tabs.Content>
        </Tabs.Root>
      </section>
    );
  }
  function ReviewerFields({ model }: { model: AppSettings["settings"]["autoApproval"]["model"] }) {
    const [selection, setSelection] = useState(model ? modelKey(model.provider, model.model) : "");
    const presets =
      session.domain
        .availableModels()
        .find((entry) => modelKey(entry.provider, entry.model) === selection)?.presets ?? [];
    const initialPreset =
      model && selection === modelKey(model.provider, model.model) ? (model.preset ?? "") : "";
    return (
      <>
        <label>
          Auto approver model
          <Select
            name="reviewerModel"
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">Use conversation model</option>
            <ModelOptions {...(model ? { selected: model } : {})} />
          </Select>
        </label>
        <label>
          Auto approver preset
          <Select
            name="reviewerPreset"
            key={selection}
            defaultValue={initialPreset}
            disabled={!selection}
          >
            <option value="">Model default</option>
            {initialPreset && !presets.some((entry) => entry.value === initialPreset) && (
              <option value={initialPreset}>{initialPreset} — unavailable</option>
            )}
            {presets.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label ?? entry.value}
              </option>
            ))}
          </Select>
        </label>
      </>
    );
  }
  function RouteError() {
    const error = useRouteError();
    const revalidator = useRevalidator();
    return (
      <section className="page">
        <h1>Could not open this view</h1>
        <p className="error" role="alert">
          {errorMessage(error)}
        </p>
        <Button
          type="button"
          disabled={revalidator.state !== "idle"}
          onClick={() => {
            void revalidator.revalidate();
          }}
        >
          Retry conversation
        </Button>
        <Link to="/new">New conversation</Link>
        <RestartButton />
      </section>
    );
  }
  return createMemoryRouter(
    [
      {
        id: "app",
        path: "/",
        Component: Layout,
        loader: async (): Promise<RootData> => {
          const [settings] = await Promise.all([
            session.readSettings(),
            session.listLoaded ? undefined : session.list(),
          ]);
          return { settings };
        },
        ErrorBoundary: RouteError,
        HydrateFallback: () => <div className="startup">Loading Harness…</div>,
        children: [
          { index: true, Component: Welcome },
          {
            path: "new",
            Component: NewConversation,
            action: async ({ request }) => {
              const data = await request.formData();
              const cwd = field(data, "cwd");
              const id = await session.create(
                cwd,
                field(data, "model"),
                field(data, "sandbox"),
                field(data, "toolMode"),
              );
              localStorage.setItem(session.storageKey("last-directory"), cwd);
              return redirect(`/conversations/${id}`);
            },
          },
          {
            path: "conversations/:conversationId",
            Component: ConversationPage,
            loader: ({ params }) => session.load(params.conversationId!),
            ErrorBoundary: RouteError,
          },
          { path: "settings", Component: Settings },
          { path: "actions", action },
        ],
      },
    ],
    { initialEntries: [localStorage.getItem(session.storageKey("route")) ?? "/"] },
  );
}
