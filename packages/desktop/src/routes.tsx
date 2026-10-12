import { SidebarLayout } from "./components/sidebar.tsx";
import { McpSettings } from "./components/mcp-settings.tsx";
import { DesktopUpdates } from "./components/desktop-updates.tsx";
import { ModelSelect, modelKey } from "./components/model-select.tsx";
import {
  useEffect,
  useEffectEvent,
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
import {
  textOf,
  compactionThresholdSchema,
  type Conversation,
  type ConversationId,
} from "@harness/protocol";
import {
  appAuthLogoutRequest,
  appSettingsUpdateRequest,
  appProviderConfigUpdateRequest,
  type AppSettings,
} from "@harness/server/client-protocol";
import type { TranscriptRow, TranscriptStep } from "./transcript.ts";
import { DesktopSession, type ConversationView } from "./session.ts";
import {
  Button,
  Input,
  Select,
  SelectItem,
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
  LoaderCircle,
  Send,
  Square,
  ChevronDown,
  Settings2,
  BookOpen,
  PenLine,
  Code,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

type ActionResult =
  { ok: true; message?: string; restartRequired?: boolean } | { ok: false; message: string };
type RootData = { settings: AppSettings };
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
  const title = view?.conversation.title ?? conversation.title;
  if (title) return title;
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
          await session.refreshSidebar();
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
        case "provider-settings": {
          const provider = session.settings?.providers.find(
            (entry) => entry.id === field(data, "provider"),
          );
          if (!provider) throw new Error("Unknown provider connection");
          const patch: Record<string, boolean> = {};
          for (const setting of provider.settings) {
            const value = field(data, `setting:${setting.key}`);
            if (value !== "true" && value !== "false")
              throw new Error(`Invalid ${setting.title} setting`);
            if ((value === "true") !== setting.value) patch[setting.key] = value === "true";
          }
          if (!Object.keys(patch).length)
            return { ok: true, message: "Provider settings unchanged." };
          await session.client.peer.request(appProviderConfigUpdateRequest, {
            provider: provider.id,
            patch,
          });
          return {
            ok: true,
            restartRequired: true,
            message: "Provider settings saved. Restart the server to apply the change.",
          };
        }
        case "settings": {
          const compactionInput = field(data, "compactionThresholdTokens");
          const compactionThresholdTokens =
            compactionInput === ""
              ? null
              : compactionThresholdSchema.parse(Number(compactionInput));
          const [provider, model] = field(data, "model").split("\u0000");
          const inWorkspace = field(data, "inWorkspace");
          const outOfWorkspace = field(data, "outOfWorkspace");
          const sandbox = field(data, "sandbox");
          const autoApproval = field(data, "autoApproval");
          const [reviewerProvider, reviewerModel] = field(data, "reviewerModel").split("\u0000");
          const reviewerPreset = reviewerModel ? field(data, "reviewerPreset") : "";
          const [titleProvider, titleModel] = field(data, "titleModel").split("\u0000");
          const titlePreset = titleModel ? field(data, "titlePreset") : "";
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
              timeoutSeconds: Number(field(data, "autoApprovalTimeoutSeconds")),
              model:
                reviewerProvider && reviewerModel
                  ? {
                      provider: reviewerProvider,
                      model: reviewerModel,
                      preset: reviewerPreset || null,
                    }
                  : null,
            },
            conversationTitleModel:
              titleProvider && titleModel
                ? { provider: titleProvider, model: titleModel, preset: titlePreset || null }
                : null,
            sandbox,
            compactionThresholdTokens,
          });
          return {
            ok: true,
            message:
              "Settings saved. New conversations use these defaults. Restart the server to apply compaction changes to already-loaded conversations.",
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
    const renderConversation = (conversation: Conversation) => {
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
          <span className="conversation-title">{conversationLabel(conversation, view)}</span>
          {status === "Running" ? (
            <LoaderCircle
              size={12}
              className="conversation-running loading-icon"
              role="img"
              aria-label="Running"
            />
          ) : (
            status && (
              <span
                className={`conversation-status-mark ${view?.approvals.size ? "approval-status" : view?.state.turn.status === "failed" ? "failed-status" : ""}`}
                aria-label={status}
                title={status}
              />
            )
          )}
          {session.unread.has(conversation.id) && (
            <span className="conversation-status-mark" aria-label="Unread" title="Unread" />
          )}
        </NavLink>
      );
    };
    return (
      <SidebarLayout
        key={session.storageKey("sidebar-groups")}
        session={session}
        controls={connections.controls}
        renderConversation={renderConversation}
      >
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
      </SidebarLayout>
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
  function SandboxOptions({ selected }: { selected?: string }) {
    return (
      <>
        <SelectItem value="local">Local</SelectItem>
        {session.settings?.platform === "linux" && <SelectItem value="native">Native</SelectItem>}
        {session.settings?.platform !== "linux" && selected === "native" && (
          <SelectItem value="native">Native (Linux only)</SelectItem>
        )}
        <SelectItem value="docker">Docker / devcontainer</SelectItem>
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
    const [preset, setPreset] = useState(defaultModel.preset ?? "");
    const catalog = session.domain
      .availableModels()
      .find((model) => modelKey(model.provider, model.model) === selection);
    const presets = catalog?.presets ?? [];
    const [backend, setBackend] = useState<string>(settings.settings.sandbox);
    const [toolMode, setToolMode] = useState<string>(settings.settings.toolMode);
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
          <Input type="hidden" name="preset" value={preset} />
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
                  <ModelSelect
                    label="New conversation model"
                    models={session.domain.availableModels()}
                    providers={session.settings?.providers ?? []}
                    value={selection}
                    onValueChange={(next) => {
                      setSelection(next);
                      setPreset("");
                    }}
                  />
                </label>
                {(presets.length > 0 || preset) && (
                  <label>
                    Preset
                    <Select
                      aria-label="New conversation preset"
                      value={preset}
                      onValueChange={(next) => setPreset(next)}
                    >
                      <SelectItem value="">Default</SelectItem>
                      {preset && !presets.some((entry) => entry.value === preset) && (
                        <SelectItem value={preset}>{preset} — unavailable</SelectItem>
                      )}
                      {presets.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label ?? entry.value}
                        </SelectItem>
                      ))}
                    </Select>
                  </label>
                )}
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
                    <Select value={backend} onValueChange={(next) => setBackend(next)}>
                      <SandboxOptions selected={backend} />
                    </Select>
                  </label>
                  <label>
                    Tool interface
                    <Select value={toolMode} onValueChange={(next) => setToolMode(next)}>
                      <SelectItem value="direct">Direct</SelectItem>
                      <SelectItem value="hybrid">Direct and code</SelectItem>
                      <SelectItem value="code-only">Code only</SelectItem>
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
            <model.Form method="post" action="/actions" className="picker-form">
              <Input type="hidden" name="intent" value="model" />
              <Input type="hidden" name="conversationId" value={id} />
              <label>
                Model
                <ModelSelect
                  label="Conversation model"
                  models={session.domain.availableModels()}
                  providers={session.settings?.providers ?? []}
                  name="model"
                  value={modelKey(selected.provider, selected.model)}
                  disabled={disabled || model.state !== "idle"}
                  onValueChange={(next) => {
                    void model.submit(
                      { intent: "model", conversationId: id, model: next },
                      { method: "post", action: "/actions" },
                    );
                  }}
                />
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
                    onValueChange={(next) => {
                      void preset.submit(
                        { intent: "preset", conversationId: id, preset: next },
                        { method: "post", action: "/actions" },
                      );
                    }}
                  >
                    <SelectItem value="">Default</SelectItem>
                    {selected.preset &&
                      !presets.some((entry) => entry.value === selected.preset) && (
                        <SelectItem value={selected.preset}>
                          {selected.preset} — unavailable
                        </SelectItem>
                      )}
                    {presets.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label ?? entry.value}
                      </SelectItem>
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
                  onValueChange={(next) => {
                    const data = new FormData();
                    data.set("intent", "sandbox");
                    data.set("conversationId", id);
                    data.set("sandbox", next);
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

  function toolIcon(name: string) {
    if (["write", "edit", "apply_patch", "str_replace_based_edit_tool"].includes(name))
      return PenLine;
    if (name === "read" || name === "read_file") return BookOpen;
    if (name === "glob" || name === "grep" || name === "tool_search") return Search;
    if (name === "eval") return Code;
    if (name === "bash" || name === "powershell" || name === "exec") return Terminal;
    return Wrench;
  }

  function argumentPreview(cell: Extract<Cell, { kind: "tool" }>, boundary?: "begin" | "result") {
    return (
      boundary === "result"
        ? (cell.output ?? "")
        : typeof cell.args === "string"
          ? cell.args
          : JSON.stringify(cell.args)
    )
      .slice(0, 300)
      .replace(/\s+/g, " ");
  }

  function ToolCall({
    cell,
    boundary,
  }: {
    cell: Extract<Cell, { kind: "tool" }>;
    boundary?: "begin" | "result" | undefined;
  }) {
    const [open, setOpen] = useState(false);
    const edit = editPresentation(cell);
    const ToolIcon = toolIcon(cell.name);
    return (
      <Disclosure
        className={`cell tool ${boundary ? `eval-${boundary}` : ""} ${cell.status === "error" && boundary !== "begin" ? "failed" : ""}`}
        data-testid="tool-call"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        title={
          <>
            <ToolIcon size={13} aria-hidden="true" className="tool-icon muted" />
            {cell.status === "error" && boundary !== "begin" && (
              <span className="tool-failure">Failed</span>
            )}
            <strong>{boundary ? `eval ${boundary}` : cell.name}</strong>
            <span className="tool-argument-preview">{argumentPreview(cell, boundary)}</span>
            {cell.approvalProgress?.status === "reviewing" && (
              <span className="tool-status muted">awaiting approval</span>
            )}
          </>
        }
      >
        {open && (
          <>
            {cell.parentCallId && <p className="muted">Invoked by {cell.parentCallId}</p>}
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
            {boundary !== "result" && (
              <>
                <h3>Arguments</h3>
                <pre>
                  {typeof cell.args === "string" ? cell.args : JSON.stringify(cell.args, null, 2)}
                </pre>
              </>
            )}
            {boundary !== "begin" && (
              <>
                <h3>Output</h3>
                <pre data-testid="tool-output">{cell.output ?? "Waiting for output…"}</pre>
              </>
            )}
            {cell.approval && (
              <p className="muted">
                {cell.approval.decision === "allow" ? "Allowed" : "Denied"} by{" "}
                {cell.approval.responder}
              </p>
            )}
          </>
        )}
      </Disclosure>
    );
  }

  function ActiveDuration({
    startedAt,
    label,
  }: {
    startedAt: number;
    label: "Thinking" | "Working";
  }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    return (
      <>
        {label} for {seconds} s
      </>
    );
  }

  function WorkPreview({ steps, expand }: { steps: TranscriptStep[]; expand: () => void }) {
    const recent = steps
      .filter(({ cell }) => cell.kind !== "reasoning" || cell.text.trim() !== "")
      .slice(-5)
      .map((step) => ({ step, lines: 1 }));
    const reasoning = recent.findLast(({ step }) => step.cell.kind === "reasoning");
    if (reasoning) reasoning.lines += 5 - recent.length;
    return (
      <div className="live-step-preview" aria-label="Recent work">
        {recent.map(({ step, lines }) => {
          if (step.cell.kind === "reasoning")
            return (
              <div
                className="preview-reasoning"
                key={step.key}
                style={{ maxHeight: `${lines * 1.65}em` }}
              >
                <span>{step.cell.text.slice(-2000)}</span>
              </div>
            );
          const cell = step.cell;
          const ToolIcon = toolIcon(cell.name);
          const boundary = "boundary" in step ? step.boundary : undefined;
          return (
            <button type="button" className="preview-tool" key={step.key} onClick={expand}>
              <ToolIcon size={13} aria-hidden="true" className="tool-icon" />
              {cell.status === "error" && boundary !== "begin" && (
                <span className="tool-failure">Failed</span>
              )}
              <span>{boundary ? `eval ${boundary}` : cell.name}</span>
              <span className="tool-argument-preview">{argumentPreview(cell, boundary)}</span>
            </button>
          );
        })}
      </div>
    );
  }

  function StepGroup({ row }: { row: Extract<TranscriptRow, { kind: "steps" }> }) {
    const [open, setOpen] = useState(false);
    const disclosure = useRef<HTMLDetailsElement>(null);
    const calls = row.steps.filter(
      (step) => step.cell.kind === "tool" && !("boundary" in step && step.boundary === "result"),
    ).length;
    const working =
      row.observedTiming !== undefined && row.observedTiming.completedAt === undefined;
    // Completed tool-only history has comparable server timestamps. Historical
    // reasoning starts do not; live groups use desktop-observed timing instead.
    const historicalTools = row.steps.every(({ cell }) => cell.kind === "tool");
    const start =
      row.observedTiming?.startedAt ??
      (historicalTools
        ? row.steps.reduce((time, { cell }) => Math.min(time, cell.startedAt), Infinity)
        : undefined);
    const end =
      row.observedTiming?.completedAt ??
      (historicalTools
        ? row.steps.reduce<number | undefined>(
            (time, { cell }) =>
              time === undefined || cell.completedAt === undefined
                ? undefined
                : Math.max(time, cell.completedAt),
            0,
          )
        : undefined);
    const duration =
      start === undefined || end === undefined ? undefined : Math.round((end - start) / 1000);
    const label = working ? (
      row.observedTiming ? (
        <ActiveDuration startedAt={row.observedTiming.startedAt} label="Working" />
      ) : (
        "Working"
      )
    ) : duration === undefined ? (
      "Worked"
    ) : (
      `Worked for ${duration} s`
    );
    return (
      <div className="cell tool-group-container">
        <Disclosure
          ref={disclosure}
          className="tool-group"
          open={open}
          title={
            <span>
              {label}
              {calls ? ` · ${calls} tool ${calls === 1 ? "call" : "calls"}` : ""}
            </span>
          }
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("summary")?.parentElement === event.currentTarget
            ) {
              // Change visibility and mount the body together. A native toggle
              // hides the tail before its queued event mounts the lazy body,
              // letting that first resize consume the virtualizer's follow request.
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
        >
          {open &&
            row.steps.map((step) =>
              step.cell.kind === "tool" ? (
                <ToolCall
                  key={step.key}
                  cell={step.cell}
                  boundary={"boundary" in step ? step.boundary : undefined}
                />
              ) : (
                <TranscriptCell key={step.key} cell={step.cell} />
              ),
            )}
        </Disclosure>
        {working && (
          <WorkPreview
            steps={row.steps}
            expand={() => {
              const summary = disclosure.current!.querySelector("summary")!;
              summary.focus();
              summary.click();
            }}
          />
        )}
      </div>
    );
  }

  function Reasoning({ cell }: { cell: Extract<Cell, { kind: "reasoning" }> }) {
    const [open, setOpen] = useState(false);
    const duration =
      cell.observedTiming && cell.completedAt !== undefined
        ? Math.round((cell.completedAt - cell.startedAt) / 1000)
        : undefined;
    const label = cell.streaming ? (
      cell.observedTiming ? (
        <ActiveDuration startedAt={cell.startedAt} label="Thinking" />
      ) : (
        "Thinking"
      )
    ) : duration === undefined ? (
      "Thought"
    ) : (
      `Thought for ${duration} s`
    );
    return (
      <Disclosure
        className="cell reasoning"
        title={label}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        {open && (
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
            {cell.text}
          </Markdown>
        )}
      </Disclosure>
    );
  }

  function TranscriptCell({ cell }: { cell: Cell }) {
    if (cell.kind === "tool") return <ToolCall cell={cell} />;
    if (cell.kind === "reasoning") return <Reasoning cell={cell} />;
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
  function Activity({ view, id, title }: { view: ConversationView; id: string; title: string }) {
    const [output, setOutput] = useState("");
    const [error, setError] = useState<string>();
    const disconnected = Boolean(session.disconnected);
    useEffect(() => {
      if (disconnected) return;
      let disposed = false;
      let pending = false;
      const refresh = async () => {
        if (pending) return;
        pending = true;
        try {
          const content = await session.plugins.activities(view.conversation.id).peek(id);
          if (!disposed) {
            setOutput(textOf(content));
            setError(undefined);
          }
        } catch (cause) {
          if (!disposed) setError(errorMessage(cause));
        } finally {
          pending = false;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), 1000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }, [view.conversation.id, id, disconnected]);
    const kill = useFetcher<ActionResult>();
    return (
      <Disclosure
        className="activity"
        title={
          <>
            <span className="activity-title">{title}</span>
            <span className="activity-preview muted">
              {output.replace(/\s+/g, " ").slice(-300)}
            </span>
            <span className="muted">running</span>
          </>
        }
      >
        <pre>{output || "Waiting for output…"}</pre>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <kill.Form method="post" action="/actions">
          <Input type="hidden" name="conversationId" value={view.conversation.id} />
          <Input type="hidden" name="activityId" value={id} />
          <Button
            type="submit"
            name="intent"
            value="activity-kill"
            disabled={kill.state !== "idle" || disconnected}
          >
            Stop activity
          </Button>
        </kill.Form>
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
          {preferences.sendWith} send · {preferences.sendWith === "Enter" ? "Shift+Enter" : "Enter"}{" "}
          newline
        </small>
      </div>
    );
  }

  function EarlierHistory({ view }: { view: ConversationView }) {
    const older = useFetcher<ActionResult>();
    const marker = useRef<HTMLDivElement>(null);
    const pending = useRef(false);
    const disconnected = Boolean(session.disconnected);
    const failed = older.data?.ok === false;
    const hasEarlier = Boolean(view.cursor);
    useEffect(() => {
      if (older.state === "idle") pending.current = false;
    }, [older.state]);
    const load = () => {
      if (pending.current || older.state !== "idle" || !view.cursor || disconnected) return;
      pending.current = true;
      void older.submit(
        { intent: "older", conversationId: view.conversation.id },
        { method: "post", action: "/actions" },
      );
    };
    const loadAutomatically = useEffectEvent(() => {
      if (!failed) load();
    });
    useEffect(() => {
      const element = marker.current;
      if (!element || !hasEarlier || disconnected) return;
      const root = element.closest(".conversation-scroll");
      if (!root) throw new Error("History marker requires a conversation scroller");
      let visible = false;
      const observer = new IntersectionObserver(
        (entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) loadAutomatically();
        },
        { root, rootMargin: "200px 0px" },
      );
      // Collapsed steps may add no height. A new upward scroll can request the
      // next page, but completing a request must not drain history on its own.
      const onWheel = (event: Event) => {
        if (visible && (event as WheelEvent).deltaY < 0) loadAutomatically();
      };
      observer.observe(element);
      root.addEventListener("wheel", onWheel, { passive: true });
      return () => {
        observer.disconnect();
        root.removeEventListener("wheel", onWheel);
      };
    }, [hasEarlier, disconnected]);
    if (!view.cursor) return <span className="muted">Start of conversation</span>;
    return (
      <div ref={marker} className="earlier-history">
        {older.state !== "idle" ? (
          <span className="muted" role="status">
            Loading earlier messages…
          </span>
        ) : (
          <button className="history-continuation muted" onClick={load} disabled={disconnected}>
            Earlier messages
          </button>
        )}
        {failed && (
          <>
            <ActionFeedback data={older.data} />
            <Button size="sm" onClick={load} disabled={older.state !== "idle" || disconnected}>
              Retry loading earlier messages
            </Button>
          </>
        )}
      </div>
    );
  }

  function ConversationPage() {
    useLive();
    const view = useLoaderData<ConversationView>();
    useEffect(() => {
      session.setActiveConversation(view.conversation.id);
      return () => session.setActiveConversation(null);
    }, [view.conversation.id]);
    return (
      <ConversationCanvas
        key={view.conversation.id}
        rows={view.transcript.rows}
        running={view.state.turn.status === "running"}
        header={
          <header className="conversation-header">
            <div className="conversation-heading">
              <h1>{conversationLabel(view.conversation, view)}</h1>
            </div>
          </header>
        }
        history={<EarlierHistory key={view.conversation.id} view={view} />}
        renderRow={(row) =>
          row.kind === "steps" ? <StepGroup row={row} /> : <TranscriptCell cell={row.cell} />
        }
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
              {view.state.activities.some((activity) => activity.status === undefined) && (
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
                  {view.state.activities
                    .filter((activity) => activity.status === undefined)
                    .map((activity) => (
                      <Activity
                        key={activity.id}
                        view={view}
                        id={activity.id}
                        title={activity.title}
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
    const configuration = useFetcher<ActionResult>();
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
        {provider.settings.length > 0 && (
          <configuration.Form
            method="post"
            action="/actions"
            className="form-grid"
            key={JSON.stringify(provider.settings)}
          >
            <Input type="hidden" name="intent" value="provider-settings" />
            <Input type="hidden" name="provider" value={provider.id} />
            {provider.settings.map((setting) => (
              <div key={setting.key}>
                <label>
                  {setting.title}
                  <Select
                    name={`setting:${setting.key}`}
                    aria-label={`${provider.label} ${setting.title}`}
                    defaultValue={String(setting.value)}
                  >
                    <SelectItem value="true">On</SelectItem>
                    <SelectItem value="false">Off</SelectItem>
                  </Select>
                </label>
                {setting.description && <p className="muted">{setting.description}</p>}
              </div>
            ))}
            <Button
              type="submit"
              disabled={configuration.state !== "idle" || Boolean(session.disconnected)}
            >
              Save provider settings
            </Button>
          </configuration.Form>
        )}
        <ActionFeedback data={configuration.data} />
        {configuration.data?.ok && configuration.data.restartRequired && <RestartButton />}
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
                  <SelectItem value="browser">Browser sign-in</SelectItem>
                  <SelectItem value="device">Device code</SelectItem>
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
    const savedSelection = modelKey(selected.provider, selected.model);
    const [defaultSelection, setDefaultSelection] = useState({
      saved: savedSelection,
      value: savedSelection,
    });
    if (defaultSelection.saved !== savedSelection)
      setDefaultSelection({ saved: savedSelection, value: savedSelection });
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
                <ModelSelect
                  label="Model for new conversations"
                  models={session.domain.availableModels()}
                  providers={session.settings?.providers ?? []}
                  name="model"
                  value={defaultSelection.value}
                  onValueChange={(value) => setDefaultSelection({ saved: savedSelection, value })}
                />
              </label>
              <label>
                Sandbox for new conversations
                <Select name="sandbox" defaultValue={settings.settings.sandbox}>
                  <SandboxOptions selected={settings.settings.sandbox} />
                </Select>
              </label>
              <label>
                Compaction threshold (input tokens)
                <Input
                  name="compactionThresholdTokens"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={settings.settings.compactionThresholdTokens ?? ""}
                  placeholder="Automatic"
                />
                <small className="muted">
                  Blank uses 85% of the model input budget. Restart the server to apply changes to
                  already-loaded conversations.
                </small>
              </label>
              <label>
                Tools inside the workspace
                <Select name="inWorkspace" defaultValue={settings.settings.approval.inWorkspace}>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="ask">Ask</SelectItem>
                  <SelectItem value="ask-human">Ask human</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </Select>
              </label>
              <label>
                Tools outside or with unknown scope
                <Select
                  name="outOfWorkspace"
                  defaultValue={settings.settings.approval.outOfWorkspace}
                >
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="ask">Ask</SelectItem>
                  <SelectItem value="ask-human">Ask human</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
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
                  <SelectItem value="false">Off</SelectItem>
                  <SelectItem value="true">On</SelectItem>
                </Select>
              </label>
              <AuxiliaryModelFields
                prefix="reviewer"
                label="Auto approver"
                key={JSON.stringify(settings.settings.autoApproval.model)}
                model={settings.settings.autoApproval.model}
              />
              <label>
                Auto approver timeout (seconds)
                <Input
                  name="autoApprovalTimeoutSeconds"
                  type="number"
                  min="0.001"
                  max="2147483"
                  step="any"
                  defaultValue={settings.settings.autoApproval.timeoutSeconds}
                  required
                />
              </label>
              <AuxiliaryModelFields
                prefix="title"
                label="Conversation naming"
                key={JSON.stringify(settings.settings.conversationTitleModel)}
                model={settings.settings.conversationTitleModel}
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
              selected, each review uses the conversation’s model. Conversation naming uses its
              selected model or the conversation’s model when unset, once after the first message.
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
  function AuxiliaryModelFields({
    model,
    prefix,
    label,
  }: {
    model: AppSettings["settings"]["autoApproval"]["model"];
    prefix: "reviewer" | "title";
    label: string;
  }) {
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
          {label} model
          <ModelSelect
            label={`${label} model`}
            models={session.domain.availableModels()}
            providers={session.settings?.providers ?? []}
            name={`${prefix}Model`}
            value={selection}
            onValueChange={setSelection}
            emptyLabel="Use conversation model"
          />
        </label>
        <label>
          {label} preset
          <Select
            name={`${prefix}Preset`}
            key={selection}
            defaultValue={initialPreset}
            disabled={!selection}
          >
            <SelectItem value="">Model default</SelectItem>
            {initialPreset && !presets.some((entry) => entry.value === initialPreset) && (
              <SelectItem value={initialPreset}>{initialPreset} — unavailable</SelectItem>
            )}
            {presets.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label ?? entry.value}
              </SelectItem>
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
            session.recents.loaded || session.recents.loading || session.recents.error
              ? undefined
              : session.refreshSidebar(),
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
              const [provider, model] = field(data, "model").split("\u0000");
              if (
                !session.domain
                  .availableModels()
                  .some((entry) => entry.provider === provider && entry.model === model)
              )
                throw new Error("Select an available model");
              await session.client.peer.request(
                appSettingsUpdateRequest,
                appSettingsUpdateRequest.params.parse({
                  model: { provider, model, preset: field(data, "preset") || null },
                  sandbox: field(data, "sandbox"),
                  toolMode: field(data, "toolMode"),
                }),
              );
              const id = await session.create(
                cwd,
                field(data, "model"),
                field(data, "sandbox"),
                field(data, "toolMode"),
                field(data, "preset"),
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
